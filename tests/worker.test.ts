import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createProviderRegistry } from 'ai';
import { MockProviderV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import type { ResolvedConfig } from '../src/config';
import { defaultGuardKinds, defaultGuards } from '../src/core/guards';
import { seedDefaults } from '../src/core/layers/service';
import { createProviderBackoff } from '../src/core/pipeline/backoff';
import type { TargetGroup } from '../src/core/pipeline/run';
import { createPricing } from '../src/core/pricing';
import { defaultProcessors } from '../src/core/processors';
import type { JobHandler, TranslateQueue, WorkOptions } from '../src/core/queue/types';
import { chunkGroups, startWorker } from '../src/core/queue/worker';
import { syncProject } from '../src/core/resources/sync';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { projects, resources, targets } from '../src/db/schema';
import { fakeModel } from './helpers/model';
import { noopQueue } from './helpers/queue';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://loqo:loqo@localhost:5432/loqo_test';

const { db, pool } = createDb(DATABASE_URL);

describe('chunkGroups', () => {
  test('splits a group into calls of at most `size` fields and leaves smaller groups alone', () => {
    const group = (locale: string, count: number) => ({ locale, jobs: Array.from({ length: count }, (_, index) => ({ target: { id: `${locale}${index}` } })) }) as unknown as TargetGroup;
    const chunks = chunkGroups([group('de', 5), group('fr', 2)], 2);
    expect(chunks.map((chunk) => `${chunk.locale}:${chunk.jobs.map((job) => job.target.id).join(',')}`)).toEqual(['de:de0,de1', 'de:de2,de3', 'de:de4', 'fr:fr0,fr1']);
  });
});

describe('worker', () => {
  /** Model calls in flight right now, and the most there ever were. */
  let inFlight = 0;
  let peak = 0;
  const callSizes: number[] = [];

  const providers = createProviderRegistry({
    fake: new MockProviderV4({
      languageModels: {
        translate: fakeModel(async (fields) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          callSizes.push(Object.keys(fields).length);
          await Bun.sleep(20);
          inFlight -= 1;
          return Object.fromEntries(Object.entries(fields).map(([id, value]) => [id, `[x] ${value}`]));
        }),
      },
    }),
  });

  const config: ResolvedConfig = {
    providers: providers as ResolvedConfig['providers'],
    guards: defaultGuards(),
    guardKinds: defaultGuardKinds(),
    processors: defaultProcessors(),
    stages: [],
    localeNames: {},
  };

  /** Hands the handler and the fetch options back instead of polling anything. */
  const capturingQueue = () => {
    let captured: { handler: JobHandler; options: WorkOptions } | undefined;
    const queue: TranslateQueue = { ...noopQueue, work: async (handler, options) => void (captured = { handler, options }) };
    return { queue, captured: () => captured };
  };

  let projectId = '';

  beforeAll(async () => {
    await runMigrations(db);
    await seedDefaults(db);
    await db.delete(projects).where(eq(projects.slug, 'worker-test'));
    const [project] = await db.insert(projects).values({ slug: 'worker-test', name: 'Worker', targetLocales: ['de', 'fr'], debounceSeconds: 0 }).returning();
    if (!project) throw new Error('no project');
    projectId = project.id;
    await syncProject({ db, queue: noopQueue }, project, [{ key: 'a', source: 'One' }, { key: 'b', source: 'Two' }, { key: 'c', source: 'Three' }], { prune: true, enqueue: false });
    await db.execute(`update layers set model = 'fake:translate' where name = 'translate'`);
    await db.execute(`update layers set enabled = false where name = 'enhance'`);
  });

  afterAll(async () => {
    await db.delete(projects).where(eq(projects.id, projectId));
    await pool.end();
  });

  test('a batch runs its groups side by side, `concurrency` at a time, in calls of `fieldsPerCall`', async () => {
    const { queue, captured } = capturingQueue();
    const deps = { db, config, pricing: createPricing(db, async () => new Response('{}', { status: 500 })), backoff: createProviderBackoff() };
    await startWorker(queue, deps, { fieldsPerCall: 2, concurrency: 3 });
    const worker = captured();
    if (!worker) throw new Error('worker never registered');
    // One fetch claims what fills the limiter; two pollers keep it full between fetches.
    expect(worker.options).toEqual({ batchSize: 6, concurrency: 2 });

    const pending = await db.select({ id: targets.id }).from(targets).innerJoin(resources, eq(resources.id, targets.resourceId)).where(eq(resources.projectId, projectId));
    expect(pending).toHaveLength(6);
    const outcomes = await worker.handler(pending.map((row, index) => ({ id: `job-${index}`, data: { targetId: row.id } })));

    // Two locales of three targets, in calls of two: [2, 1] + [2, 1], of which three ran at once.
    expect(callSizes.sort()).toEqual([1, 1, 2, 2]);
    expect(peak).toBe(3);
    expect(outcomes.size).toBe(6);
    expect([...outcomes.values()].every((outcome) => outcome.status === 'completed')).toBe(true);
    const rows = await db.select({ value: targets.value, status: targets.status }).from(targets).innerJoin(resources, eq(resources.id, targets.resourceId)).where(eq(resources.projectId, projectId));
    expect(rows.every((row) => row.status === 'translated' && row.value?.startsWith('[x] '))).toBe(true);
  });
});
