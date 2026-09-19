import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import type { ResolvedConfig } from '../src/config';
import { brandTerms, defaultGuardKinds, defaultGuards } from '../src/core/guards';
import { defaultProcessors } from '../src/core/processors';
import { countTargets, listResources, listTranslations, scopeStatus } from '../src/core/resources/service';
import { enqueueProject, syncProject } from '../src/core/resources/sync';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { type Project, projects, resources, targets, verdicts } from '../src/db/schema';
import { noopQueue } from './helpers/queue';
import type { TranslateQueue } from '../src/core/queue/types';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://loqo:loqo@localhost:5432/loqo_test';

const { db, pool } = createDb(DATABASE_URL);
const deps = { db, queue: noopQueue };
let project: Project;

const targetRows = async () => {
  const rows = await db
    .select({ key: resources.key, locale: targets.locale, value: targets.value, status: targets.status, origin: targets.origin, pinned: targets.pinned, native: targets.native })
    .from(targets)
    .innerJoin(resources, eq(resources.id, targets.resourceId))
    .where(eq(resources.projectId, project.id));
  return Object.fromEntries(rows.map((row) => [`${row.key}/${row.locale}`, row]));
};

const keys = async () => (await db.select({ key: resources.key }).from(resources).where(eq(resources.projectId, project.id))).map((row) => row.key).sort();

beforeAll(async () => {
  await runMigrations(db);
  await db.delete(projects).where(eq(projects.slug, 'sync-test'));
  const [row] = await db.insert(projects).values({ slug: 'sync-test', name: 'Sync', targetLocales: ['de', 'fr'], debounceSeconds: 0 }).returning();
  if (!row) throw new Error('no project');
  project = row;
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, project.id));
  await pool.end();
});

describe('import targets', () => {
  test('a bare string and { value } both import as legacy; pinned and native flags come along', async () => {
    const summary = await syncProject(
      deps,
      project,
      [
        { key: 'pages/1:title', source: 'Home', targets: { de: 'Start', fr: { value: 'Accueil', pinned: true } } },
        { key: 'pages/1:subtitle', source: 'Listen', targets: { de: { value: 'Hören', native: true }, fr: { pinned: true } } },
      ],
      { prune: false, enqueue: false },
    );
    expect(summary).toMatchObject({ created: 2, legacyImported: 3, pinned: 2 });
    const rows = await targetRows();
    expect(rows['pages/1:title/de']).toMatchObject({ value: 'Start', origin: 'legacy', status: 'translated', pinned: false });
    expect(rows['pages/1:title/fr']).toMatchObject({ value: 'Accueil', pinned: true });
    expect(rows['pages/1:subtitle/de']).toMatchObject({ value: 'Hören', native: true, origin: 'human' });
    // A pin without a value freezes the hole: nothing will ever be translated into it.
    expect(rows['pages/1:subtitle/fr']).toMatchObject({ value: null, status: 'pending', pinned: true });
  });

  test('re-importing never overwrites a value and never clears a flag', async () => {
    const summary = await syncProject(
      deps,
      project,
      [{ key: 'pages/1:title', source: 'Home', targets: { de: 'Startseite', fr: { value: 'Maison', pinned: false } } }],
      { prune: false, enqueue: false },
    );
    expect(summary).toMatchObject({ unchanged: 1, legacyImported: 0, pinned: 0 });
    const rows = await targetRows();
    expect(rows['pages/1:title/de']?.value).toBe('Start');
    expect(rows['pages/1:title/fr']).toMatchObject({ value: 'Accueil', pinned: true });
  });
});

describe('prunePrefix', () => {
  test('drops only the keys under the prefix that the import no longer carries', async () => {
    await syncProject(
      deps,
      project,
      [
        { key: 'pages/2:title', source: 'About' },
        { key: 'pages/2:body', source: 'Story' },
        { key: 'pages/22:title', source: 'Not a prefix match, a sibling' },
      ],
      { prune: false, enqueue: false },
    );
    const summary = await syncProject(deps, project, [{ key: 'pages/2:title', source: 'About' }], { prune: false, prunePrefix: 'pages/2:', enqueue: false });
    expect(summary.removed).toBe(1);
    expect(await keys()).toEqual(['pages/1:subtitle', 'pages/1:title', 'pages/2:title', 'pages/22:title'].sort());
  });

  test('an empty import under a prefix removes the document; an empty project-wide prune removes nothing', async () => {
    expect((await syncProject(deps, project, [], { prune: true, enqueue: false })).removed).toBe(0);
    expect((await syncProject(deps, project, [], { prune: false, prunePrefix: 'pages/2:', enqueue: false })).removed).toBe(1);
    expect(await keys()).toEqual(['pages/1:subtitle', 'pages/1:title', 'pages/22:title'].sort());
  });
});

describe('translations updatedSince', () => {
  test('returns only targets touched after the instant, with their id and updatedAt', async () => {
    const all = await listTranslations(db, { projectId: project.id, page: 1, limit: 100 });
    expect(all.docs.map((row) => `${row.key}/${row.locale}`).sort()).toEqual(['pages/1:subtitle/de', 'pages/1:title/de', 'pages/1:title/fr']);
    const newest = Math.max(...all.docs.map((row) => row.updatedAt.getTime()));
    // Inclusive: the newest row comes back for its own instant, nothing does for the next millisecond.
    expect((await listTranslations(db, { projectId: project.id, updatedSince: new Date(newest), page: 1, limit: 100 })).docs.length).toBeGreaterThan(0);
    const cutoff = new Date(newest + 1);
    expect((await listTranslations(db, { projectId: project.id, updatedSince: cutoff, page: 1, limit: 100 })).docs).toHaveLength(0);

    const title = all.docs.find((row) => row.key === 'pages/1:title' && row.locale === 'de');
    if (!title) throw new Error('no title target');
    await db.update(targets).set({ value: 'Startseite', updatedAt: new Date(newest + 1000) }).where(eq(targets.id, title.id));
    const delta = await listTranslations(db, { projectId: project.id, updatedSince: cutoff, page: 1, limit: 100 });
    expect(delta.docs.map((row) => [row.id, row.value])).toEqual([[title.id, 'Startseite']]);
  });
});

describe('legacy values the guards refuse', () => {
  test('are imported as rejected with the reason, value kept, and get a verdict', async () => {
    const config: ResolvedConfig = {
      providers: {} as ResolvedConfig['providers'],
      guards: [...defaultGuards(), brandTerms(['Acme'])],
      guardKinds: defaultGuardKinds(),
      processors: defaultProcessors(),
      stages: [],
      localeNames: {},
    };
    const summary = await syncProject(
      { ...deps, config },
      project,
      [
        { key: 'pages/3:title', source: 'Listen with Acme', targets: { de: 'Hören mit Акме', fr: 'Écouter avec Acme' } },
        { key: 'pages/3:cta', source: 'Get {{count}} free', targets: { de: 'Kostenlos erhalten' } },
      ],
      { prune: false, enqueue: false },
    );
    expect(summary).toMatchObject({ created: 2, legacyImported: 3, legacyRejected: 2 });
    const rows = await targetRows();
    expect(rows['pages/3:title/de']).toMatchObject({ value: 'Hören mit Акме', origin: 'legacy', status: 'rejected' });
    expect(rows['pages/3:title/fr']).toMatchObject({ value: 'Écouter avec Acme', status: 'translated' });
    expect(rows['pages/3:cta/de']).toMatchObject({ status: 'rejected' });
    const [rejected] = await db
      .select({ lastError: targets.lastError, id: targets.id })
      .from(targets)
      .innerJoin(resources, eq(resources.id, targets.resourceId))
      .where(and(eq(resources.key, 'pages/3:cta'), eq(targets.locale, 'de')));
    expect(rejected?.lastError).toMatch(/^legacy: template keys changed/);
    expect((await db.select().from(verdicts).where(eq(verdicts.targetId, rejected?.id ?? ''))).map((verdict) => `${verdict.guard}:${verdict.outcome}`)).toEqual(['placeholder-parity:reject']);
  });
});

describe('one document at a time', () => {
  test('prefix narrows resources and translations to a key prefix; counts group by tag or locale', async () => {
    await syncProject(
      deps,
      project,
      [
        { key: 'posts/9:title', source: 'Nine', tags: ['collection:posts', 'text'], targets: { de: 'Neun' } },
        { key: 'posts/9:body', source: 'Body', tags: ['collection:posts', 'richText'] },
      ],
      { prune: false, enqueue: false },
    );
    expect((await listResources(db, { projectId: project.id, prefix: 'posts/9:', page: 1, limit: 50 })).items.map((item) => item.key).sort()).toEqual(['posts/9:body', 'posts/9:title']);
    expect((await listTranslations(db, { projectId: project.id, prefix: 'posts/9:', page: 1, limit: 50 })).docs.map((row) => `${row.key}/${row.locale}`)).toEqual(['posts/9:title/de']);

    expect(await countTargets(db, { projectId: project.id, by: 'tag', tagPrefix: 'collection:' })).toEqual({ 'collection:posts': { translated: 1, pending: 3 } });
    expect(await countTargets(db, { projectId: project.id, by: 'locale', prefix: 'posts/9:' })).toEqual({ de: { translated: 1, pending: 1 }, fr: { pending: 2 } });
  });
});

describe('one product at a time', () => {
  const strings = (product: string, ...entries: [string, string][]) =>
    entries.map(([id, source]) => ({ key: `app-translations/${id}:value`, source, tags: ['collection:app-translations', 'text', product], targets: { de: `${source}-de` } }));

  /** A queue that only remembers what it was handed, so a scoped translate can be checked without a worker. */
  const recordingQueue = () => {
    const queued: string[] = [];
    const queue: TranslateQueue = { ...noopQueue, enqueue: async (jobs) => void queued.push(...jobs.map((job) => job.targetId)) };
    return { queue, queued };
  };

  test('pruneTags drops only resources carrying every tag that the import no longer has', async () => {
    await syncProject(deps, project, [...strings('ios', ['i1', 'One'], ['i2', 'Two']), ...strings('android', ['a1', 'Uno'])], { prune: false, enqueue: false });
    const summary = await syncProject(deps, project, strings('ios', ['i1', 'One']), { prune: false, pruneTags: ['collection:app-translations', 'ios'], enqueue: false });
    expect(summary).toMatchObject({ removed: 1, unchanged: 1 });
    const remaining = (await keys()).filter((key) => key.startsWith('app-translations/'));
    expect(remaining).toEqual(['app-translations/a1:value', 'app-translations/i1:value']);
    // Unchanged sources keep their translations: a re-import never re-translates what is current.
    expect((await targetRows())['app-translations/i1:value/de']).toMatchObject({ value: 'One-de', status: 'translated' });
  });

  test('translate within a scope queues only that scope, and never a translated value', async () => {
    const { queue, queued } = recordingQueue();
    const enqueued = await enqueueProject({ db, queue }, project, { tags: ['collection:app-translations', 'ios'] });
    const rows = await targetRows();
    // `de` came with the import; only the `fr` hole in the iOS string is missing.
    expect(enqueued).toBe(1);
    expect(rows['app-translations/i1:value/fr']).toMatchObject({ value: null });
    expect(rows['app-translations/a1:value/fr']).toMatchObject({ value: null });
    const [hole] = await db.select({ id: targets.id }).from(targets).innerJoin(resources, eq(resources.id, targets.resourceId)).where(and(eq(resources.key, 'app-translations/i1:value'), eq(targets.locale, 'fr')));
    if (!hole) throw new Error('no fr target');
    expect(queued).toEqual([hole.id]);
  });

  test('a bulk translate hands the queue one locale at a time, so a fetch merges into full calls', async () => {
    const plain = (id: string, source: string) => ({ key: `order/${id}:value`, source, tags: ['order'] });
    await syncProject(deps, project, [plain('1', 'One'), plain('2', 'Two'), plain('3', 'Three')], { prune: false, enqueue: false });
    const { queue, queued } = recordingQueue();
    expect(await enqueueProject({ db, queue }, project, { tags: ['order'] })).toBe(6);
    const localeById = new Map((await db.select({ id: targets.id, locale: targets.locale }).from(targets)).map((row) => [row.id, row.locale]));
    expect(queued.map((id) => localeById.get(id))).toEqual(['de', 'de', 'de', 'fr', 'fr', 'fr']);
  });

  test('status reports the scope\'s counts and a digest that moves only when a translated value does', async () => {
    const scope = { projectId: project.id, tags: ['collection:app-translations', 'ios'] };
    const before = await scopeStatus(db, scope);
    expect(before.counts).toEqual({ translated: 1, queued: 1 });
    expect(before.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await scopeStatus(db, { ...scope, tags: [...scope.tags, 'nothing-has-this'] })).toEqual({ counts: {}, digest: null });

    expect((await scopeStatus(db, scope)).digest).toBe(before.digest);
    await db
      .update(targets)
      .set({ value: 'Eins', updatedAt: new Date() })
      .where(and(eq(targets.locale, 'de'), sql`${targets.resourceId} in (select id from ${resources} where ${resources.key} = 'app-translations/i1:value')`));
    const after = await scopeStatus(db, scope);
    expect(after.counts).toEqual(before.counts);
    expect(after.digest).not.toBe(before.digest);
  });
});
