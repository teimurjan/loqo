import { and, eq, inArray, notInArray, type SQL, sql } from 'drizzle-orm';
import type { ResolvedConfig } from '../../config';
import type { Db, Tx } from '../../db/client';
import { type Project, resources, targets, type TargetStatus } from '../../db/schema';
import { pluralCategories } from '../model/locales';
import { sourceRevisionOf } from '../model/revision';
import { type PulledResource, pulledTarget } from '../model/types';
import { enqueueTargets } from '../queue/enqueue';
import type { TranslateQueue } from '../queue/types';
import { type ResourceScope, scopeConditions } from './scope';
import { rejectLegacyFailures } from './validate';

export type SyncSummary = {
  pulled: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  legacyImported: number;
  /** Legacy values the guards refused; imported as `rejected` so they are re-translated, not shipped. */
  legacyRejected: number;
  /** Targets the adapter asked to freeze (`targets[locale].pinned`). */
  pinned: number;
  enqueued: number;
  /** Keys that differ only by case or surrounding whitespace — almost always a mistake upstream. */
  duplicates: string[];
};

export type SyncOptions = {
  /** Delete resources the adapter no longer reports. Off for partial imports. */
  prune: boolean;
  /** Prune only keys under this prefix — one document's worth — leaving the rest of the project alone. */
  prunePrefix?: string;
  /** Prune only resources carrying every one of these tags — one collection's or one product's worth. */
  pruneTags?: string[];
  enqueue: boolean;
};

const CHUNK = 500;
/**
 * The worker merges jobs that share a locale into one model call, and the queue hands jobs out in
 * insertion order — so a bulk enqueue lines them up locale by locale, and keys near each other
 * (same document, same collection) tend to share a scenario, and so a prompt.
 */
const QUEUE_ORDER = [targets.locale, resources.key];
/** Drizzle spreads a JS array into a value list, so the locales travel as one delimited string. */
const LOCALE_SEPARATOR = String.fromCharCode(31);
const ALL_QUANTITIES = ['zero', 'one', 'two', 'few', 'many', 'other'];

const findDuplicateKeys = (keys: string[]): string[] => {
  const seen = new Map<string, number>();
  for (const key of keys) {
    const normalized = key.toLowerCase().trim();
    seen.set(normalized, (seen.get(normalized) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);
};

const sameStrings = (a: string[], b: string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

/** jsonb reorders keys on the way in, so compare canonical forms. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, current: unknown) =>
    current !== null && typeof current === 'object' && !Array.isArray(current)
      ? Object.fromEntries(Object.entries(current as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : current,
  );

const sameMeta = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => canonical(a) === canonical(b);

const normalize = (pulled: PulledResource) => ({
  key: pulled.key,
  source: pulled.source,
  sourceRevision: sourceRevisionOf(pulled.source, pulled.meta?.comment),
  tags: [...new Set(pulled.tags ?? [])].sort(),
  meta: Object.fromEntries(Object.entries(pulled.meta ?? {}).filter(([, value]) => value !== undefined)),
  translatable: pulled.translatable ?? true,
});

/**
 * Makes every (resource, locale) pair exist and puts it in the right state: `skipped` when the
 * resource is untranslatable or the plural category does not exist in that locale, `pending` when
 * there is no value or the value predates the current source. Pinned targets are never touched.
 */
export const reconcileTargets = async (db: Db, project: Project): Promise<void> => {
  if (project.targetLocales.length === 0) return;

  await db.execute(sql`
    insert into ${targets} (resource_id, locale)
    select r.id, l.locale
    from ${resources} r cross join unnest(string_to_array(${project.targetLocales.join(LOCALE_SEPARATOR)}, chr(31))) as l(locale)
    where r.project_id = ${project.id}
    on conflict (resource_id, locale) do nothing
  `);

  const missingCategories = project.targetLocales.flatMap((locale) => {
    const allowed = pluralCategories(locale);
    return ALL_QUANTITIES.filter((quantity) => !allowed.has(quantity)).map((quantity) => sql`(${locale}, ${quantity})`);
  });
  const notApplicable =
    missingCategories.length > 0
      ? sql`(t.locale, r.meta->>'quantity') in (${sql.join(missingCategories, sql`, `)})`
      : sql`false`;

  const nextStatus = sql`case
      when r.translatable = false or ${notApplicable} then 'skipped'::target_status
      when t.status = 'skipped' or t.value is null or t.source_revision is distinct from r.source_revision then 'pending'::target_status
      else t.status
    end`;
  // Only rows whose status moves are touched, so `updated_at` stays a real change marker for delta pulls.
  await db.execute(sql`
    update ${targets} t
    set status = ${nextStatus}, updated_at = now()
    from ${resources} r
    where t.resource_id = r.id
      and r.project_id = ${project.id}
      and t.pinned = false
      and t.status not in ('queued', 'translating')
      and t.status is distinct from ${nextStatus}
  `);
};

const pruneScope = (options: SyncOptions, pulledCount: number) => {
  const scoped = scopeConditions({ prefix: options.prunePrefix, tags: options.pruneTags });
  if (scoped.length > 0) return and(...scoped);
  // A project-wide prune of an empty pull would wipe the project; treat it as an adapter failure instead.
  return options.prune && pulledCount > 0 ? sql`true` : null;
};

const chunked = <T>(rows: T[], size = CHUNK): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += size) batches.push(rows.slice(index, index + size));
  return batches;
};

/**
 * A batch travels as one jsonb parameter and is joined back to its resource by key, so a whole
 * import costs one statement per chunk rather than one per value — the difference between seconds
 * and minutes once a project has six figures of targets.
 */
const batch = (rows: unknown[], columns: SQL): SQL => sql`jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as v(${columns})`;

const ofProject = (project: Project): SQL => sql`join ${resources} r on r.project_id = ${project.id} and r.key = v.key`;

type LegacyValue = { key: string; locale: string; value: string };

/** Legacy values only ever fill a hole; once the platform owns a target, the store is downstream. */
const fillLegacy = async (tx: Tx, project: Project, values: LegacyValue[]): Promise<string[]> => {
  const { rows } = await tx.execute(sql`
    update ${targets} t
    set value = v.value, origin = 'legacy', status = 'translated', source_revision = r.source_revision, updated_at = now()
    from ${batch(values, sql`key text, locale text, value text`)}
    ${ofProject(project)}
    where t.resource_id = r.id
      and t.locale = v.locale
      and t.value is null
      and t.pinned = false
      and t.status <> 'skipped'
    returning t.id
  `);
  return rows.map((row) => row.id as string);
};

/** Flags only ever go on: the platform is where they come off. `native` also claims the value as human-approved. */
const raiseFlag = async (tx: Tx, project: Project, pairs: { key: string; locale: string }[], flag: 'pinned' | 'native'): Promise<number> => {
  const assignment = flag === 'pinned' ? sql`pinned = true` : sql`native = true, origin = 'human'`;
  const stillOff = flag === 'pinned' ? sql`t.pinned = false` : sql`t.native = false`;
  const { rowCount } = await tx.execute(sql`
    update ${targets} t
    set ${assignment}, updated_at = now()
    from ${batch(pairs, sql`key text, locale text`)}
    ${ofProject(project)}
    where t.resource_id = r.id and t.locale = v.locale and ${stillOff}
  `);
  return rowCount ?? 0;
};

type ResourceUpdate = { id: string } & ReturnType<typeof normalize>;

const updateResources = async (tx: Tx, updates: ResourceUpdate[]): Promise<void> => {
  // jsonb_to_recordset matches its columns by name, so the payload spells them the way the table does.
  const rows = updates.map(({ id, key, source, sourceRevision, tags, meta, translatable }) => ({ id, key, source, source_revision: sourceRevision, tags, meta, translatable }));
  await tx.execute(sql`
    update ${resources} r
    set key = v.key,
        source = v.source,
        source_revision = v.source_revision,
        tags = array(select jsonb_array_elements_text(v.tags)),
        meta = v.meta,
        translatable = v.translatable,
        updated_at = now()
    from ${batch(rows, sql`id uuid, key text, source text, source_revision text, tags jsonb, meta jsonb, translatable boolean`)}
    where r.id = v.id
  `);
};

/** `config` brings the guards; without it (a bare test), legacy values are imported unjudged. */
export const syncProject = async (
  deps: { db: Db; queue: TranslateQueue; config?: ResolvedConfig },
  project: Project,
  pulled: PulledResource[],
  options: SyncOptions,
): Promise<SyncSummary> => {
  const { db } = deps;
  const summary: SyncSummary = {
    pulled: pulled.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    legacyImported: 0,
    legacyRejected: 0,
    pinned: 0,
    enqueued: 0,
    duplicates: findDuplicateKeys(pulled.map((resource) => resource.key)),
  };

  const existing = new Map(
    (await db.select().from(resources).where(eq(resources.projectId, project.id))).map((row) => [row.key, row]),
  );
  const seenKeys = new Set<string>();
  const toInsert: (typeof resources.$inferInsert)[] = [];
  const toUpdate: ResourceUpdate[] = [];

  for (const raw of pulled) {
    const next = normalize(raw);
    if (seenKeys.has(next.key)) continue;
    seenKeys.add(next.key);
    const current = existing.get(next.key);
    if (!current) {
      toInsert.push({ projectId: project.id, ...next });
      continue;
    }
    const changed =
      current.sourceRevision !== next.sourceRevision ||
      current.source !== next.source ||
      current.translatable !== next.translatable ||
      !sameStrings(current.tags, next.tags) ||
      !sameMeta(current.meta, next.meta);
    if (changed) {
      toUpdate.push({ id: current.id, ...next });
    } else {
      summary.unchanged += 1;
    }
  }

  await db.transaction(async (tx) => {
    for (const rows of chunked(toInsert)) await tx.insert(resources).values(rows);
    summary.created = toInsert.length;
    for (const rows of chunked(toUpdate)) await updateResources(tx, rows);
    summary.updated = toUpdate.length;

    const scope = pruneScope(options, pulled.length);
    if (scope) {
      const removed = await tx
        .delete(resources)
        .where(and(eq(resources.projectId, project.id), scope, seenKeys.size > 0 ? notInArray(resources.key, [...seenKeys]) : undefined))
        .returning({ id: resources.id });
      summary.removed = removed.length;
    }
  });

  await reconcileTargets(db, project);

  const imported = pulled.flatMap((resource) =>
    Object.entries(resource.targets ?? {})
      .filter(([locale]) => project.targetLocales.includes(locale))
      .map(([locale, target]) => ({ key: resource.key, locale, ...pulledTarget(target) })),
  );
  if (imported.length > 0) {
    const legacy = imported.flatMap((entry) => (entry.value && entry.value.trim().length > 0 ? [{ key: entry.key, locale: entry.locale, value: entry.value }] : []));
    const pinned = imported.filter((entry) => entry.pinned).map(({ key, locale }) => ({ key, locale }));
    const native = imported.filter((entry) => entry.native).map(({ key, locale }) => ({ key, locale }));

    const filledIds: string[] = [];
    await db.transaction(async (tx) => {
      for (const rows of chunked(legacy)) filledIds.push(...(await fillLegacy(tx, project, rows)));
      for (const rows of chunked(pinned)) summary.pinned += await raiseFlag(tx, project, rows, 'pinned');
      for (const rows of chunked(native)) await raiseFlag(tx, project, rows, 'native');
    });
    summary.legacyImported = filledIds.length;
    if (deps.config) summary.legacyRejected = await rejectLegacyFailures(db, deps.config, project, filledIds);
  }

  if (options.enqueue) {
    const pending = await db
      .select({ id: targets.id })
      .from(targets)
      .innerJoin(resources, eq(resources.id, targets.resourceId))
      .where(and(eq(resources.projectId, project.id), eq(targets.status, 'pending')))
      .orderBy(...QUEUE_ORDER);
    summary.enqueued = await enqueueTargets(deps.queue, db, pending.map((row) => row.id), { debounceSeconds: project.debounceSeconds });
  }

  return summary;
};

/** What a manual translate queues by default; `force` re-queues translated values too. */
const REQUEUEABLE: TargetStatus[] = ['pending', 'rejected', 'failed'];

/** Targets worth (re)queuing by hand — project-wide or within a scope, optionally narrowed to some statuses. */
export const enqueueProject = async (
  deps: { db: Db; queue: TranslateQueue },
  project: Project,
  options: ResourceScope & { locales?: string[]; statuses?: TargetStatus[]; force?: boolean; debounceSeconds?: number },
): Promise<number> => {
  await reconcileTargets(deps.db, project);
  const statuses = options.statuses ?? (options.force ? [...REQUEUEABLE, 'translated'] : REQUEUEABLE);
  const rows = await deps.db
    .select({ id: targets.id })
    .from(targets)
    .innerJoin(resources, eq(resources.id, targets.resourceId))
    .where(
      and(
        eq(resources.projectId, project.id),
        eq(targets.pinned, false),
        inArray(targets.status, statuses),
        options.locales && options.locales.length > 0 ? inArray(targets.locale, options.locales) : undefined,
        ...scopeConditions(options),
      ),
    )
    .orderBy(...QUEUE_ORDER);
  return enqueueTargets(deps.queue, deps.db, rows.map((row) => row.id), {
    debounceSeconds: options.debounceSeconds ?? 0,
    force: options.force,
  });
};
