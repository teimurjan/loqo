import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { costSummary, layerRuns, projects, resources, type TargetStatus, targets } from '../../db/schema';
import type { QueueCounts, TranslateQueue } from '../queue/types';

const QUEUE_LIMIT = 500;
export const SUSPICIOUS_LIMIT = 500;

export type QueueItem = {
  id: string;
  resourceId: string;
  projectSlug: string;
  key: string;
  locale: string;
  status: TargetStatus;
  source: string;
  updatedAt: Date;
};

export type QueueStatus = {
  queue: QueueCounts | null;
  targets: Record<string, number>;
  /** What the worker holds or is about to: in-flight targets first, then the longest waiting. */
  items: QueueItem[];
  recentFailures: {
    id: string;
    resourceId: string;
    locale: string;
    key: string;
    projectSlug: string;
    status: TargetStatus;
    lastError: string | null;
    updatedAt: Date;
  }[];
};

/** `projectIds` narrows the target counts, items and failures; the queue totals are process-wide either way. */
export const queueStatus = async (db: Db, queue: TranslateQueue, projectIds?: string[]): Promise<QueueStatus> => {
  const scoped = projectIds ? inArray(resources.projectId, projectIds) : undefined;
  const [counts, statusRows, items, failures] = await Promise.all([
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
        resourceId: targets.resourceId,
        projectSlug: projects.slug,
        key: resources.key,
        locale: targets.locale,
        status: targets.status,
        source: resources.source,
        updatedAt: targets.updatedAt,
      })
      .from(targets)
      .innerJoin(resources, eq(resources.id, targets.resourceId))
      .innerJoin(projects, eq(projects.id, resources.projectId))
      .where(and(inArray(targets.status, ['queued', 'translating']), scoped))
      .orderBy(desc(sql`${targets.status} = 'translating'`), asc(targets.updatedAt))
      .limit(QUEUE_LIMIT),
    db
      .select({
        id: targets.id,
        resourceId: targets.resourceId,
        locale: targets.locale,
        key: resources.key,
        projectSlug: projects.slug,
        status: targets.status,
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
    items,
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
    .limit(SUSPICIOUS_LIMIT);

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

export type CostFilter = { from?: Date; to?: Date; projectIds?: string[] };

const costWhere = (filter: CostFilter) =>
  and(
    filter.from ? gte(costSummary.createdAt, filter.from) : undefined,
    filter.to ? lte(costSummary.createdAt, filter.to) : undefined,
    filter.projectIds ? inArray(costSummary.projectId, filter.projectIds) : undefined,
  );

export const costByDimension = async (db: Db, options: CostFilter & { groupBy: CostDimension }): Promise<CostRow[]> => {
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
    .where(costWhere(options))
    .groupBy(dimension)
    .orderBy(sql`sum(${costSummary.costUsd}) desc nulls last`);
};

export type CostStack = Exclude<CostDimension, 'day'>;

export type DailyCostRow = { day: string; group: string | null; costUsd: number | null };

/** Spend per day, split by `stackBy` when given; one row per day otherwise. */
export const dailyCost = (db: Db, options: CostFilter & { stackBy?: CostStack }): Promise<DailyCostRow[]> => {
  const day = sql<string>`${costSummary.day}::text`;
  const dimension = options.stackBy ? DIMENSION_COLUMN[options.stackBy] : undefined;
  const buckets = dimension ? [day, dimension] : [day];
  return db
    .select({
      day: day.as('day'),
      group: (dimension ? sql<string | null>`${dimension}` : sql<string | null>`null`).as('group'),
      costUsd: sql<number | null>`sum(${costSummary.costUsd})::float`,
    })
    .from(costSummary)
    .where(costWhere(options))
    .groupBy(...buckets)
    .orderBy(...buckets);
};

export const recentRuns = (db: Db, limit: number, projectIds?: string[]) =>
  db
    .select({ run: layerRuns, projectSlug: projects.slug })
    .from(layerRuns)
    .leftJoin(projects, eq(projects.id, layerRuns.projectId))
    .where(projectIds ? inArray(layerRuns.projectId, projectIds) : undefined)
    .orderBy(desc(layerRuns.createdAt))
    .limit(limit);
