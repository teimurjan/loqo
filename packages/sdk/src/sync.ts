import type { ApiResult, OpendeeplClient } from './client';
import type { Adapter, ImportOptions, PushResource, PushResult, SyncSummary, TranslationRow } from './types';

/**
 * The adapter protocol over HTTP: `pull()` feeds `POST /import`, `GET /translations` feeds `push()`,
 * from wherever the adapter's code runs (a CI step, a CMS plugin).
 */

const missing = (adapter: Adapter, half: 'pull' | 'push'): ApiResult<never> => ({
  ok: false,
  error: { status: 422, message: `adapter "${adapter.name}" has no ${half}()` },
});

/** `adapter.pull()` → `POST /import`. */
export const importResources = async (
  client: OpendeeplClient,
  slug: string,
  adapter: Adapter,
  options: ImportOptions = {},
): Promise<ApiResult<SyncSummary>> => {
  if (!adapter.pull) return missing(adapter, 'pull');
  const project = await client.project(slug);
  if (!project.ok) return project;
  const { resources } = await adapter.pull({ project: project.data });
  return client.import(slug, { resources, ...options });
};

/** Rows are one (resource, locale) each; an adapter wants one resource with all its locales. */
export const foldTranslations = (rows: TranslationRow[]): PushResource[] => {
  const byKey = new Map<string, PushResource>();
  for (const row of rows) {
    if (row.value === null) continue;
    const resource = byKey.get(row.key) ?? {
      key: row.key,
      source: row.source,
      tags: row.tags,
      meta: row.meta,
      translatable: row.translatable,
      targets: {},
    };
    resource.targets[row.locale] = { value: row.value, status: row.status, origin: row.origin, pinned: row.pinned, native: row.native };
    byKey.set(row.key, resource);
  }
  return [...byKey.values()];
};

export type ApplyOptions = {
  locale?: string;
  /** Only resources under this key prefix — one document's worth. */
  prefix?: string;
  /** Only targets changed after this instant; pass the `latestUpdatedAt` of the previous apply. */
  updatedSince?: Date | string;
  pageSize?: number;
};

export type ApplyResult = { pushed: PushResult; resources: number; latestUpdatedAt: string | null };

const newest = (a: string | null, b: string): string => (a === null || b > a ? b : a);

/** `GET /translations` (all pages) → `adapter.push()`. */
export const applyTranslations = async (
  client: OpendeeplClient,
  slug: string,
  adapter: Adapter,
  options: ApplyOptions = {},
): Promise<ApiResult<ApplyResult>> => {
  if (!adapter.push) return missing(adapter, 'push');
  const project = await client.project(slug);
  if (!project.ok) return project;

  const rows: TranslationRow[] = [];
  let latestUpdatedAt: string | null = null;
  for (let page = 1; ; page += 1) {
    const result = await client.translations(slug, { locale: options.locale, prefix: options.prefix, updatedSince: options.updatedSince, page, limit: options.pageSize ?? 500 });
    if (!result.ok) return result;
    for (const row of result.data.docs) latestUpdatedAt = newest(latestUpdatedAt, row.updatedAt);
    rows.push(...result.data.docs);
    if (!result.data.hasMore) break;
  }

  const resources = foldTranslations(rows);
  const pushed = resources.length === 0 ? { written: 0 } : await adapter.push({ project: project.data }, resources);
  return { ok: true, data: { pushed, resources: resources.length, latestUpdatedAt } };
};

export type SyncRemoteOptions = ImportOptions & ApplyOptions;

export type SyncRemoteResult = { imported: SyncSummary; applied: ApplyResult };

/** Import, then apply: one round trip of the store through the platform. */
export const syncRemote = async (
  client: OpendeeplClient,
  slug: string,
  adapter: Adapter,
  options: SyncRemoteOptions = {},
): Promise<ApiResult<SyncRemoteResult>> => {
  const { prune, prunePrefix, enqueue, ...apply } = options;
  const imported = await importResources(client, slug, adapter, { prune, prunePrefix, enqueue });
  if (!imported.ok) return imported;
  const applied = await applyTranslations(client, slug, adapter, apply);
  if (!applied.ok) return applied;
  return { ok: true, data: { imported: imported.data, applied: applied.data } };
};
