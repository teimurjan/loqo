import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { dailyCost, queueStatus } from '../src/core/ops/service';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { layerRuns, projects, resources, type TargetStatus, targets } from '../src/db/schema';
import { noopQueue } from './helpers/queue';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://loqo:loqo@localhost:5432/loqo_test';

const { db, pool } = createDb(DATABASE_URL);

const ids = { ios: '', android: '' };

const seedProject = async (slug: string, statuses: [locale: string, status: TargetStatus, minutesAgo: number][]) => {
  const [project] = await db.insert(projects).values({ slug, name: slug, targetLocales: ['de', 'fr', 'ja'] }).returning();
  if (!project) throw new Error('no project');
  const [resource] = await db.insert(resources).values({ projectId: project.id, key: `${slug}.title`, source: 'Hello', sourceRevision: 'r1' }).returning();
  if (!resource) throw new Error('no resource');
  const now = Date.now();
  await db.insert(targets).values(
    statuses.map(([locale, status, minutesAgo]) => ({
      resourceId: resource.id,
      locale,
      status,
      lastError: status === 'rejected' || status === 'failed' ? `${status} in ${locale}` : null,
      updatedAt: new Date(now - minutesAgo * 60_000),
    })),
  );
  return project.id;
};

const run = (projectId: string, model: string, day: string, costUsd: number | null) => ({
  runId: randomUUID(),
  projectId,
  locale: 'de',
  layerName: 'translate',
  model,
  targetCount: 1,
  costUsd,
  createdAt: new Date(`${day}T12:00:00Z`),
});

beforeAll(async () => {
  await runMigrations(db);
  await db.delete(projects);
  ids.ios = await seedProject('ops-ios', [
    ['de', 'queued', 5],
    ['fr', 'translating', 1],
    ['ja', 'rejected', 2],
  ]);
  ids.android = await seedProject('ops-android', [
    ['de', 'queued', 30],
    ['fr', 'failed', 3],
  ]);
  await db.insert(layerRuns).values([
    run(ids.ios, 'gpt-a', '2026-09-01', 0.5),
    run(ids.ios, 'gpt-a', '2026-09-01', 0.25),
    run(ids.ios, 'gpt-b', '2026-09-01', 1),
    run(ids.ios, 'gpt-b', '2026-09-03', null),
    run(ids.android, 'gpt-a', '2026-09-01', 7),
  ]);
});

afterAll(async () => {
  await pool.end();
});

describe('queueStatus', () => {
  test('lists only waiting and in-flight targets of the scoped projects, in-flight first', async () => {
    const status = await queueStatus(db, noopQueue, [ids.ios]);
    expect(status.items.map((item) => [item.projectSlug, item.locale, item.status])).toEqual([
      ['ops-ios', 'fr', 'translating'],
      ['ops-ios', 'de', 'queued'],
    ]);
    expect(status.targets).toEqual({ queued: 1, translating: 1, rejected: 1 });
  });

  test('puts the longest waiting target first across projects', async () => {
    const status = await queueStatus(db, noopQueue, [ids.ios, ids.android]);
    expect(status.items.map((item) => `${item.projectSlug}:${item.locale}`)).toEqual(['ops-ios:fr', 'ops-android:de', 'ops-ios:de']);
  });

  test('tells rejections from failures and links each to its resource', async () => {
    const status = await queueStatus(db, noopQueue, [ids.ios, ids.android]);
    expect(status.recentFailures.map((failure) => [failure.status, failure.lastError])).toEqual([
      ['rejected', 'rejected in ja'],
      ['failed', 'failed in fr'],
    ]);
    expect(status.recentFailures.every((failure) => failure.resourceId.length > 0)).toBe(true);
  });
});

describe('dailyCost', () => {
  test('splits each day by the stack dimension within the scoped projects', async () => {
    const rows = await dailyCost(db, { stackBy: 'model', projectIds: [ids.ios] });
    expect(rows).toEqual([
      { day: '2026-09-01', group: 'gpt-a', costUsd: 0.75 },
      { day: '2026-09-01', group: 'gpt-b', costUsd: 1 },
      { day: '2026-09-03', group: 'gpt-b', costUsd: null },
    ]);
  });

  test('returns one row per day without a stack dimension', async () => {
    const rows = await dailyCost(db, { projectIds: [ids.ios, ids.android] });
    expect(rows).toEqual([
      { day: '2026-09-01', group: null, costUsd: 8.75 },
      { day: '2026-09-03', group: null, costUsd: null },
    ]);
  });
});
