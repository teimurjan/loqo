import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  type LayerRun,
  type Project,
  type Resource,
  type Target,
  type TargetStatus,
  type Verdict,
  layerRunTargets,
  layerRuns,
  projects,
  resources,
  targets,
  verdicts,
} from '../../db/schema';
import { enqueueTargets } from '../queue/enqueue';
import type { TranslateQueue } from '../queue/types';
import { type ResourceScope, scopeConditions } from './scope';

export type TargetSummary = Pick<Target, 'id' | 'locale' | 'status' | 'origin' | 'pinned' | 'native' | 'value' | 'updatedAt'>;

export type ResourceListItem = Resource & { targets: TargetSummary[] };

export type ResourceFilter = {
  projectId: string;
  q?: string;
  /** Exact key prefix — one document's worth under a store's key scheme. */
  prefix?: string;
  status?: TargetStatus;
  locale?: string;
  tag?: string;
  page: number;
  limit: number;
};

export const listResources = async (db: Db, filter: ResourceFilter): Promise<{ items: ResourceListItem[]; total: number }> => {
  const conditions = [eq(resources.projectId, filter.projectId)];
  if (filter.q) conditions.push(or(ilike(resources.key, `%${filter.q}%`), ilike(resources.source, `%${filter.q}%`)) ?? sql`true`);
  if (filter.prefix) conditions.push(sql`starts_with(${resources.key}, ${filter.prefix})`);
  if (filter.tag) conditions.push(sql`${filter.tag} = any(${resources.tags})`);
  if (filter.status || filter.locale) {
    const targetConditions = [sql`t.resource_id = ${resources.id}`];
    if (filter.status) targetConditions.push(sql`t.status = ${filter.status}`);
    if (filter.locale) targetConditions.push(sql`t.locale = ${filter.locale}`);
    conditions.push(sql`exists (select 1 from ${targets} t where ${sql.join(targetConditions, sql` and `)})`);
  }
  const where = and(...conditions);

  const [[totalRow], rows] = await Promise.all([
    db.select({ total: count() }).from(resources).where(where),
    db
      .select()
      .from(resources)
      .where(where)
      .orderBy(asc(resources.key))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit),
  ]);
  const ids = rows.map((row) => row.id);
  const targetRows =
    ids.length === 0
      ? []
      : await db
          .select({
            id: targets.id,
            resourceId: targets.resourceId,
            locale: targets.locale,
            status: targets.status,
            origin: targets.origin,
            pinned: targets.pinned,
            native: targets.native,
            value: targets.value,
            updatedAt: targets.updatedAt,
          })
          .from(targets)
          .where(inArray(targets.resourceId, ids))
          .orderBy(asc(targets.locale));
  const byResource = new Map<string, TargetSummary[]>();
  for (const { resourceId, ...target } of targetRows) {
    byResource.set(resourceId, [...(byResource.get(resourceId) ?? []), target]);
  }
  return {
    items: rows.map((row) => ({ ...row, targets: byResource.get(row.id) ?? [] })),
    total: totalRow?.total ?? 0,
  };
};

export type TargetDetail = Target & { verdicts: Verdict[]; runs: LayerRun[] };

export type ResourceDetail = Resource & { project: Project; targets: TargetDetail[] };

export const getResource = async (db: Db, id: string): Promise<ResourceDetail | null> => {
  const [row] = await db
    .select({ resource: resources, project: projects })
    .from(resources)
    .innerJoin(projects, eq(projects.id, resources.projectId))
    .where(eq(resources.id, id))
    .limit(1);
  if (!row) return null;

  const targetRows = await db.select().from(targets).where(eq(targets.resourceId, id)).orderBy(asc(targets.locale));
  const targetIds = targetRows.map((target) => target.id);
  const [verdictRows, runRows] =
    targetIds.length === 0
      ? [[], []]
      : await Promise.all([
          db.select().from(verdicts).where(inArray(verdicts.targetId, targetIds)).orderBy(desc(verdicts.createdAt)),
          db
            .select({ targetId: layerRunTargets.targetId, run: layerRuns })
            .from(layerRunTargets)
            .innerJoin(layerRuns, eq(layerRuns.id, layerRunTargets.layerRunId))
            .where(inArray(layerRunTargets.targetId, targetIds))
            .orderBy(desc(layerRuns.createdAt)),
        ]);

  return {
    ...row.resource,
    project: row.project,
    targets: targetRows.map((target) => ({
      ...target,
      verdicts: verdictRows.filter((verdict) => verdict.targetId === target.id),
      runs: runRows.filter((run) => run.targetId === target.id).map((run) => run.run),
    })),
  };
};

export const getTarget = async (db: Db, id: string): Promise<{ target: Target; resource: Resource; project: Project } | null> => {
  const [row] = await db
    .select({ target: targets, resource: resources, project: projects })
    .from(targets)
    .innerJoin(resources, eq(resources.id, targets.resourceId))
    .innerJoin(projects, eq(projects.id, resources.projectId))
    .where(eq(targets.id, id))
    .limit(1);
  return row ?? null;
};

export const setPinned = async (db: Db, id: string, pinned: boolean): Promise<Target | null> => {
  const [row] = await db.update(targets).set({ pinned, updatedAt: new Date() }).where(eq(targets.id, id)).returning();
  return row ?? null;
};

/** Native marks the current value as human-approved; it therefore also becomes `origin: human`. */
export const setNative = async (db: Db, id: string, native: boolean): Promise<Target | null> => {
  const [row] = await db
    .update(targets)
    .set({ native, ...(native ? { origin: 'human' as const } : {}), updatedAt: new Date() })
    .where(eq(targets.id, id))
    .returning();
  return row ?? null;
};

/** A human edit is a translation at the current source revision, and clears any guard rejection. */
export const setValue = async (db: Db, id: string, value: string): Promise<Target | null> => {
  const current = await getTarget(db, id);
  if (!current) return null;
  const [row] = await db
    .update(targets)
    .set({
      value,
      origin: 'human',
      status: 'translated',
      sourceRevision: current.resource.sourceRevision,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(targets.id, id))
    .returning();
  return row ?? null;
};

export const retranslate = async (deps: { db: Db; queue: TranslateQueue }, id: string): Promise<Target | null> => {
  const current = await getTarget(deps.db, id);
  if (!current) return null;
  if (current.target.pinned) await setPinned(deps.db, id, false);
  await enqueueTargets(deps.queue, deps.db, [id], { debounceSeconds: 0, force: true });
  const refreshed = await getTarget(deps.db, id);
  return refreshed?.target ?? null;
};

export type TranslationRow = {
  id: string;
  key: string;
  source: string;
  tags: string[];
  meta: Record<string, unknown>;
  translatable: boolean;
  locale: string;
  value: string | null;
  status: TargetStatus;
  origin: Target['origin'];
  pinned: boolean;
  native: boolean;
  updatedAt: Date;
};

/** Where the next page picks up in `(key, locale)` order; opaque to the caller, which just hands it back. */
export type TranslationsCursor = { key: string; locale: string };

export const encodeTranslationsCursor = (row: TranslationsCursor): string =>
  Buffer.from(JSON.stringify([row.key, row.locale])).toString('base64url');

export const decodeTranslationsCursor = (cursor: string): TranslationsCursor | null => {
  try {
    const [key, locale] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    return typeof key === 'string' && typeof locale === 'string' ? { key, locale } : null;
  } catch {
    return null;
  }
};

/**
 * What app repos' import steps page through: every translated value with its resource context.
 * `updatedSince` is inclusive, so a caller that passes back the newest `updatedAt` it saw sees that
 * row again rather than missing one that landed in the same millisecond.
 *
 * Page numbers are kept for small pulls and older clients, but a full import should follow `cursor`:
 * `offset` makes the database walk every row it has already served, so a six-figure project's last
 * pages cost seconds each, while the cursor starts each page at an index seek.
 */
export const listTranslations = async (
  db: Db,
  options: { projectId: string; locale?: string; prefix?: string; updatedSince?: Date; page?: number; limit: number; after?: TranslationsCursor },
): Promise<{ page: number; limit: number; hasMore: boolean; cursor: string | null; docs: TranslationRow[] }> => {
  const page = options.page ?? 1;
  const docs = await db
    .select({
      id: targets.id,
      key: resources.key,
      source: resources.source,
      tags: resources.tags,
      meta: resources.meta,
      translatable: resources.translatable,
      locale: targets.locale,
      value: targets.value,
      status: targets.status,
      origin: targets.origin,
      pinned: targets.pinned,
      native: targets.native,
      updatedAt: targets.updatedAt,
    })
    .from(targets)
    .innerJoin(resources, eq(resources.id, targets.resourceId))
    .where(
      and(
        eq(resources.projectId, options.projectId),
        eq(targets.status, 'translated'),
        options.locale ? eq(targets.locale, options.locale) : undefined,
        options.prefix ? sql`starts_with(${resources.key}, ${options.prefix})` : undefined,
        options.updatedSince ? gte(targets.updatedAt, options.updatedSince) : undefined,
        // The row comparison is the real condition; the redundant `key >=` is what the planner can use
        // as a bound on `resources_project_key`, turning each page into an index seek instead of a sort.
        options.after ? gte(resources.key, options.after.key) : undefined,
        options.after ? sql`(${resources.key}, ${targets.locale}) > (${options.after.key}, ${options.after.locale})` : undefined,
      ),
    )
    .orderBy(asc(resources.key), asc(targets.locale))
    .limit(options.limit)
    .offset(options.after ? 0 : (page - 1) * options.limit);
  const hasMore = docs.length === options.limit;
  const last = docs.at(-1);
  return { page, limit: options.limit, hasMore, cursor: hasMore && last ? encodeTranslationsCursor(last) : null, docs };
};

export type CountsQuery = {
  projectId: string;
  /** `tag`: one group per tag starting with `tagPrefix`; `locale`: one group per target locale. */
  by: 'tag' | 'locale';
  tagPrefix?: string;
  /** Only resources under this key prefix. */
  prefix?: string;
};

export type StatusCounts = Partial<Record<TargetStatus, number>>;

/**
 * Targets by status, grouped — what a status page shows without paging through every resource.
 * A resource carrying two matching tags counts once under each.
 */
export const countTargets = async (db: Db, query: CountsQuery): Promise<Record<string, StatusCounts>> => {
  const group = query.by === 'tag' ? sql`tag.value` : targets.locale;
  const from =
    query.by === 'tag'
      ? sql`${targets} inner join ${resources} on ${resources.id} = ${targets.resourceId} cross join unnest(${resources.tags}) as tag(value)`
      : sql`${targets} inner join ${resources} on ${resources.id} = ${targets.resourceId}`;
  const where = and(
    eq(resources.projectId, query.projectId),
    query.prefix ? sql`starts_with(${resources.key}, ${query.prefix})` : undefined,
    query.by === 'tag' && query.tagPrefix ? sql`starts_with(tag.value, ${query.tagPrefix})` : undefined,
  );
  const rows = await db.execute<{ group: string; status: TargetStatus; total: number }>(
    sql`select ${group} as "group", ${targets.status} as status, count(*)::int as total from ${from} where ${where} group by 1, 2 order by 1, 2`,
  );
  const counts: Record<string, StatusCounts> = {};
  for (const row of rows.rows) (counts[row.group] ??= {})[row.status] = row.total;
  return counts;
};

export type ScopeStatus = { counts: StatusCounts; digest: string | null };

/**
 * Where a scope stands and what it holds: targets by status, and one hash over every translated
 * value (in key/locale order), so a consumer can tell "done" from "done, and different from what
 * I last took" without paging through the translations. `null` when nothing is translated yet.
 */
export const scopeStatus = async (db: Db, query: { projectId: string } & ResourceScope): Promise<ScopeStatus> => {
  const where = and(eq(resources.projectId, query.projectId), ...scopeConditions(query));
  const [countRows, [digestRow]] = await Promise.all([
    db.select({ status: targets.status, total: count() }).from(targets).innerJoin(resources, eq(resources.id, targets.resourceId)).where(where).groupBy(targets.status),
    db
      .select({
        digest: sql<string | null>`encode(sha256(convert_to(string_agg(md5(${resources.key} || chr(31) || ${targets.locale} || chr(31) || ${targets.value}), '' order by ${resources.key}, ${targets.locale}), 'UTF8')), 'hex')`,
      })
      .from(targets)
      .innerJoin(resources, eq(resources.id, targets.resourceId))
      .where(and(where, eq(targets.status, 'translated'))),
  ]);
  const counts: StatusCounts = {};
  for (const row of countRows) counts[row.status] = row.total;
  return { counts, digest: digestRow?.digest ?? null };
};
