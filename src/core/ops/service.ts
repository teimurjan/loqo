import { and, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { costSummary, layerRuns, projects, resources, targets } from '../../db/schema';
import type { QueueCounts, TranslateQueue } from '../queue/types';

export type QueueStatus = {
  queue: QueueCounts | null;
  targets: Record<string, number>;
  recentFailures: { id: string; locale: string; key: string; projectSlug: string; lastError: string | null; updatedAt: Date }[];
};

/** `projectIds` narrows the target counts and failures; the queue totals are process-wide either way. */
export const queueStatus = async (db: Db, queue: TranslateQueue, projectIds?: string[]): Promise<QueueStatus> => {
  const scoped = projectIds ? inArray(resources.projectId, projectIds) : undefined;
  const [counts, statusRows, failures] = await Promise.all([
    queue.counts(),
    db
      .select({ status: targets.status, total: sql<number>`count(*)::int` })
      .from(targets)
      .innerJoin(resources, eq(resources.id, targets.resourceId))
      .where(scoped)
      .groupBy(targets.status),
    db
      .select({
        id: targets.id,
        locale: targets.locale,
        key: resources.key,
        projectSlug: projects.slug,
        lastError: targets.lastError,
        updatedAt: targets.updatedAt,
      })
      .from(targets)
      .innerJoin(resources, eq(resources.id, targets.resourceId))
      .innerJoin(projects, eq(projects.id, resources.projectId))
      .where(and(sql`${targets.status} in ('rejected', 'failed')`, scoped))
      .orderBy(desc(targets.updatedAt))
      .limit(50),
  ]);
  return {
    queue: counts,
    targets: Object.fromEntries(statusRows.map((row) => [row.status, row.total])),
    recentFailures: failures,
  };
};

export type SuspiciousTarget = {
  id: string;
  resourceId: string;
  projectSlug: string;
  locale: string;
  key: string;
  value: string | null;
};

/** A translation identical to its source usually means the model gave up, not that the word is universal. */
export const suspiciousTargets = async (db: Db, projectIds?: string[]): Promise<SuspiciousTarget[]> =>
  db
    .select({
      id: targets.id,
      resourceId: targets.resourceId,
      projectSlug: projects.slug,
      locale: targets.locale,
      key: resources.key,
      value: targets.value,
    })
    .from(targets)
    .innerJoin(resources, eq(resources.id, targets.resourceId))
    .innerJoin(projects, eq(projects.id, resources.projectId))
    .where(
      and(
        eq(targets.status, 'translated'),
        eq(targets.native, false),
        ne(targets.locale, projects.sourceLocale),
        sql`${targets.value} = ${resources.source}`,
        sql`${resources.source} ~ '[[:alpha:]]{3,}'`,
        projectIds ? inArray(resources.projectId, projectIds) : undefined,
      ),
    )
    .orderBy(desc(targets.updatedAt))
    .limit(500);

export type CostDimension = 'project' | 'locale' | 'layer' | 'model' | 'day';

export type CostRow = {
  group: string | null;
  runs: number;
  targets: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  unpriced: number;
};

const DIMENSION_COLUMN: Record<CostDimension, ReturnType<typeof sql>> = {
  project: sql`${costSummary.projectSlug}`,
  locale: sql`${costSummary.locale}`,
  layer: sql`${costSummary.layerName}`,
  model: sql`${costSummary.model}`,
  day: sql`${costSummary.day}::text`,
};

export const costByDimension = async (
  db: Db,
  options: { groupBy: CostDimension; from?: Date; to?: Date; projectIds?: string[] },
): Promise<CostRow[]> => {
  const dimension = DIMENSION_COLUMN[options.groupBy];
  return db
    .select({
      group: sql<string | null>`${dimension}`.as('group'),
      runs: sql<number>`count(*)::int`,
      targets: sql<number>`coalesce(sum(${costSummary.targetCount}), 0)::int`,
      inputTokens: sql<number>`coalesce(sum(${costSummary.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${costSummary.outputTokens}), 0)::int`,
      costUsd: sql<number | null>`sum(${costSummary.costUsd})::float`,
      unpriced: sql<number>`count(*) filter (where ${costSummary.costUsd} is null and ${costSummary.error} is null)::int`,
    })
    .from(costSummary)
    .where(
      and(
        options.from ? gte(costSummary.createdAt, options.from) : undefined,
        options.to ? lte(costSummary.createdAt, options.to) : undefined,
        options.projectIds ? inArray(costSummary.projectId, options.projectIds) : undefined,
      ),
    )
    .groupBy(dimension)
    .orderBy(sql`sum(${costSummary.costUsd}) desc nulls last`);
};

export const recentRuns = (db: Db, limit: number, projectIds?: string[]) =>
  db
    .select({ run: layerRuns, projectSlug: projects.slug })
    .from(layerRuns)
    .leftJoin(projects, eq(projects.id, layerRuns.projectId))
    .where(projectIds ? inArray(layerRuns.projectId, projectIds) : undefined)
    .orderBy(desc(layerRuns.createdAt))
    .limit(limit);
