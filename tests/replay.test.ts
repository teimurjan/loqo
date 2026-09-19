import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createProviderRegistry } from 'ai';
import { MockLanguageModelV4, MockProviderV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import { pulledTarget, type PulledResource } from '@loqo/sdk';
import type { ResolvedConfig } from '../src/config';
import { signIn } from '../src/core/auth/service';
import { brandTerms, defaultGuardKinds, defaultGuards } from '../src/core/guards';
import { loadLayerCatalog } from '../src/core/layers/resolve';
import { seedDefaults } from '../src/core/layers/service';
import { type Envelope, fromEnvelope, toEnvelope } from '../src/core/pipeline/llm';
import { runGroup, type TargetJob } from '../src/core/pipeline/run';
import { createProviderBackoff } from '../src/core/pipeline/backoff';
import { createPricing } from '../src/core/pricing';
import { defaultProcessors } from '../src/core/processors';
import { createProject, deleteProject } from '../src/core/projects/service';
import { groupJobs } from '../src/core/queue/worker';
import { syncProject } from '../src/core/resources/sync';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { type Project, projects, resources, targets, users, verdicts } from '../src/db/schema';
import { noopQueue } from './helpers/queue';

/**
 * Replays production translations through the pipeline. The site's regression test exports a sample
 * of its content — every resource with the translations the old engine stored — and here a model
 * stub answers every prompt with exactly that stored translation. Whatever the pipeline then rejects
 * (a guard) or alters (a processor) is a place where it disagrees with what production holds today:
 * either the new rule is stricter, or the old engine let something through. Both are worth a look.
 *
 * LOQO_REPLAY=<export.json> (`{ sourceLocale, targetLocales, resources: PulledResource[] }`);
 * LOQO_LOCALES=de,ja narrows the locales; LOQO_BRAND_TERMS=Acme,Acme+ adds the brand-terms
 * guard the deployment runs. Needs the test Postgres like every pipeline test.
 */
const REPLAY = process.env.LOQO_REPLAY;
const LOCALES = process.env.LOQO_LOCALES?.split(',').map((locale) => locale.trim()) ?? null;
const BRAND_TERMS = process.env.LOQO_BRAND_TERMS?.split(',').map((term) => term.trim()).filter(Boolean) ?? [];
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://loqo:loqo@localhost:5433/loqo_test';
const EXAMPLES = 12;

type Export = { sourceLocale: string; targetLocales: string[]; resources: PulledResource[] };

const excerpt = (value: string | null): string => {
  const text = JSON.stringify(value) ?? 'null';
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
};

const { db, pool } = createDb(DATABASE_URL);

/** Stored translation by target id, filled once the targets exist. */
const stored = new Map<string, string>();
const answers: string[] = [];

const replayModel = () =>
  new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const user = prompt.find((message) => message.role === 'user');
      const text = user?.role === 'user' && user.content[0]?.type === 'text' ? user.content[0].text : '';
      const fields = fromEnvelope(JSON.parse(text) as Envelope);
      answers.push(`${Object.keys(fields).length}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(toEnvelope(Object.fromEntries(Object.keys(fields).map((id) => [id, stored.get(id) ?? fields[id] ?? ''])))) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
        warnings: [],
      };
    },
  });

const config: ResolvedConfig = {
  providers: createProviderRegistry({ replay: new MockProviderV4({ languageModels: { model: replayModel() } }) }) as ResolvedConfig['providers'],
  guards: [...defaultGuards(), ...(BRAND_TERMS.length > 0 ? [brandTerms(BRAND_TERMS)] : [])],
  guardKinds: defaultGuardKinds(),
  processors: defaultProcessors(),
  stages: [],
  localeNames: {},
  repairModel: 'replay:model',
};

let project: Project;
let sample: Export;

describe.skipIf(!REPLAY)('replay of stored translations', () => {
  beforeAll(async () => {
    sample = (await Bun.file(REPLAY as string).json()) as Export;
    await runMigrations(db);
    await seedDefaults(db);
    await deleteProject(db, 'replay');
    await db.delete(users).where(eq(users.email, 'replay@example.com'));
    const owner = await signIn(db, { sub: 'replay', email: 'replay@example.com', name: 'Replay', avatarUrl: null });
    const targetLocales = LOCALES ? sample.targetLocales.filter((locale) => LOCALES.includes(locale)) : sample.targetLocales;
    project = await createProject(db, { slug: 'replay', name: 'Replay', sourceLocale: sample.sourceLocale, targetLocales, debounceSeconds: 0 }, owner);
    // Every layer, and the repair call, answers from the stored translations.
    await db.execute(`update layers set model = 'replay:model'`);
    // Imported without their translations, so every target is pending and the pipeline has to produce one.
    const bare = sample.resources.map(({ targets: _targets, ...resource }) => resource);
    await syncProject({ db, queue: noopQueue }, project, bare, { prune: true, enqueue: false });
  }, 300_000);

  afterAll(async () => {
    await pool.end();
  });

  test(
    'what the old engine stored passes the guards and survives the processors unchanged',
    async () => {
      const byKey = new Map(sample.resources.map((resource) => [resource.key, resource]));
      const pending = await db
        .select({ target: targets, resource: resources, project: projects })
        .from(targets)
        .innerJoin(resources, eq(resources.id, targets.resourceId))
        .innerJoin(projects, eq(projects.id, resources.projectId))
        .where(eq(resources.projectId, project.id));
      const jobs: TargetJob[] = [];
      for (const job of pending) {
        if (job.target.status !== 'pending') continue;
        const target = byKey.get(job.resource.key)?.targets?.[job.target.locale];
        const value = target === undefined ? undefined : pulledTarget(target).value;
        if (value === undefined) continue;
        stored.set(job.target.id, value);
        jobs.push(job);
      }
      console.log(`[replay] ${jobs.length} stored translations across ${sample.resources.length} resources and ${project.targetLocales.length} locales`);

      const catalog = await loadLayerCatalog(db);
      const deps = { db, config, pricing: createPricing(db, async () => new Response('{}', { status: 500 })), backoff: createProviderBackoff() };
      const { groups, unresolved } = await groupJobs(deps, catalog, jobs);
      for (const group of groups) await runGroup(deps, group);

      // By project, not by id: a full replay is far more targets than Postgres takes as bind parameters.
      const replayed = new Set(jobs.map((job) => job.target.id));
      const rows = (
        await db.select({ target: targets }).from(targets).innerJoin(resources, eq(resources.id, targets.resourceId)).where(eq(resources.projectId, project.id))
      )
        .map(({ target }) => target)
        .filter((target) => replayed.has(target.id));
      const rejections = (
        await db
          .select({ verdict: verdicts })
          .from(verdicts)
          .innerJoin(targets, eq(targets.id, verdicts.targetId))
          .innerJoin(resources, eq(resources.id, targets.resourceId))
          .where(eq(resources.projectId, project.id))
      ).map(({ verdict }) => verdict);
      const labels = new Map(jobs.map((job) => [job.target.id, `${job.resource.key} [${job.target.locale}]`]));
      const label = (id: string): string => labels.get(id) ?? id;

      const rejected = rows.filter((row) => row.status !== 'translated').map((row) => `${label(row.id)}: ${row.status} — ${row.lastError ?? ''}`);
      const altered = rows
        .filter((row) => row.status === 'translated' && row.value !== stored.get(row.id))
        .map((row) => `${label(row.id)}: ${excerpt(row.value)} ≠ stored ${excerpt(stored.get(row.id) ?? null)}`);
      const byGuard = new Map<string, number>();
      for (const verdict of rejections) {
        if (verdict.outcome === 'pass') continue;
        byGuard.set(`${verdict.guard}:${verdict.outcome}`, (byGuard.get(`${verdict.guard}:${verdict.outcome}`) ?? 0) + 1);
      }
      // One locale standing out is a script or typography problem; all of them evenly is a rule.
      const byLocale = new Map<string, number>();
      for (const row of rows) {
        if (row.status === 'translated' && row.value === stored.get(row.id)) continue;
        byLocale.set(row.locale, (byLocale.get(row.locale) ?? 0) + 1);
      }

      console.log(
        [
          `[replay] ${rows.length} targets: ${rows.length - rejected.length} translated, ${rejected.length} not, ${altered.length} altered by processors, ${unresolved.length} unresolved, ${answers.length} model calls`,
          ...[...byGuard].map(([guard, count]) => `  ${guard}: ${count}`),
          `  by locale: ${[...byLocale].sort(([, a], [, b]) => b - a).map(([locale, count]) => `${locale} ${count}`).join(', ')}`,
          ...(rejected.length > 0 ? ['  rejected, e.g.:', ...rejected.slice(0, EXAMPLES).map((line) => `    ${line}`)] : []),
          ...(altered.length > 0 ? ['  altered, e.g.:', ...altered.slice(0, EXAMPLES).map((line) => `    ${line}`)] : []),
          ...(unresolved.length > 0 ? ['  unresolved, e.g.:', ...unresolved.slice(0, EXAMPLES).map((job) => `    ${job.resource.key} [${job.target.locale}]`)] : []),
        ].join('\n'),
      );

      expect({ rejected: rejected.length, altered: altered.length, unresolved: unresolved.length }).toEqual({ rejected: 0, altered: 0, unresolved: 0 });
    },
    30 * 60_000,
  );
});
