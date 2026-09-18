import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createProviderRegistry } from 'ai';
import { MockProviderV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import type { ResolvedConfig } from '../src/config';
import { brandTerms, defaultGuardKinds, defaultGuards } from '../src/core/guards';
import type { Guard } from '../src/core/guards/types';
import { loadLayerCatalog } from '../src/core/layers/resolve';
import { seedDefaults } from '../src/core/layers/service';
import { createProviderBackoff } from '../src/core/pipeline/backoff';
import { createPricing } from '../src/core/pricing';
import { defaultProcessors } from '../src/core/processors';
import { hasTag } from '../src/core/model/types';
import { runGroup } from '../src/core/pipeline/run';
import type { Stage } from '../src/core/pipeline/stage';
import { groupJobs } from '../src/core/queue/worker';
import { syncProject } from '../src/core/resources/sync';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { guardRules, layerRuns, projects, prompts, promptVersions, resources, scenarios, targets, verdicts } from '../src/db/schema';
import { fakeModel } from './helpers/model';
import { noopQueue } from './helpers/queue';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://opendeepl:opendeepl@localhost:5432/opendeepl_test';

const { db, pool } = createDb(DATABASE_URL);
const calls: string[] = [];
/** Every source text the translate model was handed. */
const translated: string[] = [];

const providers = createProviderRegistry({
  fake: new MockProviderV4({
    languageModels: {
      translate: fakeModel((fields, system) => {
        calls.push(`translate:${Object.keys(fields).length}`);
        translated.push(...Object.values(fields));
        return Object.fromEntries(
          Object.entries(fields).map(([id, value]) => {
            // Drop the specifier once to trip the parity guard; keep everything else intact.
            if (value.includes('%1$lld')) return [id, 'Elemente verschoben'];
            if (value === 'Nothing comes back') return [id, ''];
            if (value.includes('Acme')) return [id, value.replace('Acme', 'Акме')];
            return [id, `[${system.includes('German') ? 'de' : 'xx'}] ${value}`];
          }),
        );
      }),
      shorten: fakeModel((fields) => {
        calls.push('repair');
        // Misses the cut on the first pass, as a model that cannot count does, then lands it.
        return Object.fromEntries(Object.entries(fields).map(([id, value]) => [id, value.length > 8 ? value.slice(0, 8) : value.slice(0, 6)]));
      }),
    },
  }),
});

const config: ResolvedConfig = {
  providers: providers as ResolvedConfig['providers'],
  guards: [...defaultGuards(), brandTerms(['Acme'])],
  guardKinds: defaultGuardKinds(),
  processors: defaultProcessors(),
  stages: [],
  localeNames: {},
  repairModel: 'fake:shorten',
};

let projectId = '';

beforeAll(async () => {
  await runMigrations(db);
  await db.delete(projects);
  await db.delete(layerRuns);
  await seedDefaults(db);
  const [project] = await db
    .insert(projects)
    .values({ slug: 'test', name: 'Test', targetLocales: ['de'], debounceSeconds: 0 })
    .returning();
  if (!project) throw new Error('no project');
  projectId = project.id;
  // An iOS scenario adds a fragment to the translate layer and attaches brand-terms explicitly.
  const [scenario] = await db.insert(scenarios).values({ projectId, name: 'iOS', tags: ['ios'] }).returning();
  if (!scenario) throw new Error('no scenario');
  const [tone] = await db.insert(prompts).values({ layerId: null, name: 'ios-tone', scope: 'scenario', scopeRef: scenario.id, position: 50 }).returning();
  if (!tone) throw new Error('no prompt');
  await db.insert(promptVersions).values({ promptId: tone.id, version: 1, body: 'SCENARIO-FRAGMENT' });
  await db.insert(guardRules).values({ guard: 'brand-terms', scope: 'scenario', scopeRef: scenario.id, params: { terms: ['Acme'] } });
  await syncProject(
    { db, queue: noopQueue },
    project,
    [
      { key: 'a', source: 'Hello', tags: ['webapp'] },
      { key: 'b', source: 'World', tags: ['webapp'] },
      { key: 'c', source: '%1$lld items moved', tags: ['ios'] },
      { key: 'd', source: 'Welcome to Acme' },
      { key: 'e', source: 'A rather long sentence', meta: { maxLength: 6 } },
      { key: 'f', source: 'Bye', translatable: false },
      { key: 'g', source: 'one item', tags: ['android', 'plural'], meta: { quantity: 'few' } },
      { key: 'h', source: 'Nothing comes back' },
    ],
    { prune: true, enqueue: false },
  );
});

afterAll(async () => {
  await pool.end();
});

describe('pipeline', () => {
  test('sync skips untranslatable resources and plural categories the locale lacks', async () => {
    const rows = await db
      .select({ key: resources.key, status: targets.status })
      .from(targets)
      .innerJoin(resources, eq(resources.id, targets.resourceId))
      .where(eq(resources.projectId, projectId));
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row.status]));
    expect(byKey.f).toBe('skipped');
    expect(byKey.g).toBe('skipped');
    expect(byKey.a).toBe('pending');
  });

  test('groups targets by resolved layers, records verdicts, repairs and rejections', async () => {
    const pending = await db
      .select({ target: targets, resource: resources, project: projects })
      .from(targets)
      .innerJoin(resources, eq(resources.id, targets.resourceId))
      .innerJoin(projects, eq(projects.id, resources.projectId))
      .where(eq(targets.status, 'pending'));
    expect(pending).toHaveLength(6);

    // Point the seeded layers at the fake provider and drop the second pass for a simpler trace.
    await db.execute(`update layers set model = 'fake:translate' where name = 'translate'`);
    await db.execute(`update layers set enabled = false where name = 'enhance'`);

    const catalog = await loadLayerCatalog(db);
    const deps = { db, config, pricing: createPricing(db, async () => new Response('{}', { status: 500 })), backoff: createProviderBackoff() };
    const { groups, unresolved } = await groupJobs(deps, catalog, pending);
    expect(unresolved).toHaveLength(0);
    // a+b share the plain webapp prompt (its {{key}} fragment renders per key, so they do not merge);
    // c (ios), d (default) and e (length budget) each render a different system prompt.
    expect(groups.length).toBeGreaterThanOrEqual(4);

    // The scenario fragment and guard rule reach only the ios resource; the others see neither.
    const iosGroup = groups.find((group) => group.jobs.some((job) => job.resource.key === 'c'));
    const plainGroup = groups.find((group) => group.jobs.some((job) => job.resource.key === 'a'));
    expect(iosGroup?.layers[0]?.systemPrompt).toContain('SCENARIO-FRAGMENT');
    expect(plainGroup?.layers[0]?.systemPrompt).not.toContain('SCENARIO-FRAGMENT');
    const iosGuards = iosGroup?.jobs.find((job) => job.resource.key === 'c')?.guards ?? [];
    expect(iosGuards.filter((guard) => guard.name === 'brand-terms')).toHaveLength(1);
    expect(iosGuards.find((guard) => guard.name === 'brand-terms')?.match({ projectSlug: 'test', sourceLocale: 'en', locale: 'de', key: 'c', tags: [], meta: {} })).toBe(true);

    for (const group of groups) await runGroup(deps, group);

    const rows = await db
      .select({ key: resources.key, status: targets.status, value: targets.value, lastError: targets.lastError, id: targets.id })
      .from(targets)
      .innerJoin(resources, eq(resources.id, targets.resourceId))
      .where(eq(resources.projectId, projectId));
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));

    expect(byKey.a?.status).toBe('translated');
    expect(byKey.a?.value).toBe('[de] Hello');
    expect(byKey.c?.status).toBe('rejected');
    expect(byKey.c?.lastError).toMatch(/format specifiers changed/);
    expect(byKey.d?.status).toBe('rejected');
    expect(byKey.d?.lastError).toMatch(/brand term "Acme" missing/);
    expect(byKey.e?.status).toBe('translated');
    expect(byKey.e?.value).toHaveLength(6);
    // An empty answer is not a translation, and never becomes a copy of the source.
    expect(byKey.h?.status).toBe('rejected');
    expect(byKey.h?.lastError).toMatch(/layer "translate" returned no value/);
    expect(byKey.h?.value).toBeNull();

    const eVerdicts = await db.select().from(verdicts).where(eq(verdicts.targetId, byKey.e?.id ?? ''));
    // Two repair passes for the length cap: the first landed at 8, the second at 6.
    expect(eVerdicts.filter((verdict) => verdict.guard === 'length-cap').map((verdict) => verdict.outcome)).toEqual(['reject', 'reject', 'pass']);
    const eRuns = await db.select().from(layerRuns);
    expect(eRuns.filter((run) => run.kind === 'repair' && run.model === 'fake:shorten')).toHaveLength(3);
    expect(eRuns.every((run) => run.costUsd === null)).toBe(true);
    // e spent two of length-cap's three attempts; c and d each spent brand-terms' / placeholder-parity's one.
    expect(calls.filter((call) => call === 'repair')).toHaveLength(3);
  });
});

/** A translation memory as a stage: exact hits are settled before any model sees them. */
const memoryStage = (memory: Record<string, string>): Stage => ({
  name: 'memory',
  position: 5,
  description: 'Exact-match translation memory',
  match: (ctx) => hasTag(ctx, 'tm'),
  run: async ({ fields }) => {
    const hits = fields.filter((field) => memory[field.source] !== undefined);
    return { fields: Object.fromEntries(hits.map((field) => [field.id, memory[field.source] ?? ''])), settled: hits.map((field) => field.id) };
  },
});

const postEditStage: Stage = {
  name: 'post-edit',
  position: 30,
  match: () => true,
  run: async ({ fields }) => ({ fields: Object.fromEntries(fields.map((field) => [field.id, `${field.text} !`])) }),
};

const asyncBan: Guard = {
  name: 'async-ban',
  match: () => true,
  check: async (candidate) => {
    await Bun.sleep(1);
    return candidate.includes('Forbidden') ? 'async guard says no' : null;
  },
};

describe('pipeline topology', () => {
  test('code stages run among the layers by position, settle fields per match, and guards may be async', async () => {
    const [project] = await db
      .insert(projects)
      .values({ slug: 'stages', name: 'Stages', targetLocales: ['de'], debounceSeconds: 0 })
      .returning();
    if (!project) throw new Error('no project');
    await syncProject(
      { db, queue: noopQueue },
      project,
      [
        { key: 'tm', source: 'Hello', tags: ['tm'] },
        { key: 'plain', source: 'World' },
        { key: 'bad', source: 'Forbidden word' },
      ],
      { prune: true, enqueue: false },
    );
    await db.execute(`update layers set model = 'fake:translate' where name = 'translate'`);
    await db.execute(`update layers set enabled = false where name = 'enhance'`);

    const pending = await db
      .select({ target: targets, resource: resources, project: projects })
      .from(targets)
      .innerJoin(resources, eq(resources.id, targets.resourceId))
      .innerJoin(projects, eq(projects.id, resources.projectId))
      .where(eq(resources.projectId, project.id));
    expect(pending).toHaveLength(3);

    const staged: ResolvedConfig = { ...config, guards: [...config.guards, asyncBan], stages: [postEditStage, memoryStage({ Hello: 'Hallo (memory)' })] };
    const deps = { db, config: staged, pricing: createPricing(db, async () => new Response('{}', { status: 500 })), backoff: createProviderBackoff() };
    const { groups } = await groupJobs(deps, await loadLayerCatalog(db), pending);
    translated.length = 0;
    for (const group of groups) await runGroup(deps, group);

    const rows = await db
      .select({ key: resources.key, status: targets.status, value: targets.value, lastError: targets.lastError, id: targets.id })
      .from(targets)
      .innerJoin(resources, eq(resources.id, targets.resourceId))
      .where(eq(resources.projectId, project.id));
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));

    // The memory hit never reached the model or the post-edit stage; the rest went through both, in order.
    expect(byKey.tm?.status).toBe('translated');
    expect(byKey.tm?.value).toBe('Hallo (memory)');
    expect(translated.sort()).toEqual(['Forbidden word', 'World']);
    expect(byKey.plain?.value).toBe('[de] World !');
    expect(byKey.bad?.status).toBe('rejected');
    expect(byKey.bad?.lastError).toBe('async guard says no');
    const badVerdicts = await db.select().from(verdicts).where(eq(verdicts.targetId, byKey.bad?.id ?? ''));
    expect(badVerdicts.find((verdict) => verdict.guard === 'async-ban')?.outcome).toBe('reject');

    // Only model calls land in the ledger, and only for the fields they saw.
    const runs = await db.select().from(layerRuns).where(eq(layerRuns.projectId, project.id));
    expect(runs.every((run) => run.layerName === 'translate')).toBe(true);
    expect(runs.reduce((total, run) => total + run.targetCount, 0)).toBe(2);
  });
});
