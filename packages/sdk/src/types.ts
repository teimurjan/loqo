/**
 * The canonical resource model. An adapter turns a content store into `PulledResource`s and
 * `PushResource`s back into the store; the platform never sees anything else.
 */
export type ResourceKey = string;

export type PulledTarget = {
  /** A translation already present in the store, imported once as `origin: legacy`. */
  value?: string;
  /** Freeze the target: the pipeline never overwrites it. Only ever sets the flag, never clears it. */
  pinned?: boolean;
  /** Human-approved as native quality. Only ever sets the flag, never clears it. */
  native?: boolean;
};

export type PulledResource = {
  key: ResourceKey;
  source: string;
  /** Drive prompt-fragment scoping and guard matching: `ios`, `android`, `webapp`, `plural`, ... */
  tags?: string[];
  /** Adapter-specific context exposed to prompts as `{{meta.*}}`: filePath, quantity, comment, maxLength. */
  meta?: Record<string, unknown>;
  /** `false` mirrors Android `translatable="false"`. */
  translatable?: boolean;
  /** A bare string is `{ value }`. */
  targets?: Record<string, string | PulledTarget>;
};

export type PullResult = { resources: PulledResource[] };

export type PushTarget = { value: string; status: string; origin: string | null; pinned: boolean; native: boolean };

export type PushResource = {
  key: ResourceKey;
  source: string;
  tags: string[];
  meta: Record<string, unknown>;
  translatable: boolean;
  targets: Record<string, PushTarget>;
};

/** A target the store refused (validation, conversion); it stays translated on the platform, the caller decides. */
export type PushRejection = { key: ResourceKey; locale: string; reason: string };

export type PushResult = { written: number; files?: string[]; rejected?: PushRejection[] };

export type ProjectRef = { slug: string; name: string; sourceLocale: string; targetLocales: string[] };

export type AdapterContext = { project: ProjectRef };

/**
 * Runs where the content lives (a CI step, a CMS plugin) and talks to the platform over HTTP through
 * `importResources` / `applyTranslations`. Either half may be left out: a store that is only ever
 * read needs no `push()`, one that only receives translations needs no `pull()`.
 */
export interface Adapter {
  readonly name: string;
  pull?(ctx: AdapterContext): Promise<PullResult>;
  push?(ctx: AdapterContext, resources: PushResource[]): Promise<PushResult>;
}

/** Normalizes the two accepted `targets[locale]` shapes. */
export const pulledTarget = (target: string | PulledTarget): PulledTarget => (typeof target === 'string' ? { value: target } : target);

/* ── Platform API shapes ───────────────────────────────────────────────────────────────────── */

export type TargetStatus = 'pending' | 'queued' | 'translating' | 'translated' | 'rejected' | 'failed' | 'skipped';
export type TargetOrigin = 'machine' | 'human' | 'legacy';

export type SyncSummary = {
  pulled: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  legacyImported: number;
  /** Legacy values the platform's guards refused; imported as rejected, to be re-translated. */
  legacyRejected: number;
  pinned: number;
  enqueued: number;
  duplicates: string[];
};

/**
 * The part of a project a store syncs at a time: resources under a key prefix (one document) and/or
 * carrying every one of the tags (one collection, one product). Both narrow; neither alone is required.
 */
export type ResourceScope = { prefix?: string; tags?: string[] };

export type ImportOptions = {
  /** Delete every project resource not in this import. Off by default: most imports are partial. */
  prune?: boolean;
  /** Delete only resources whose key starts with this prefix and are not in this import — one document's worth. */
  prunePrefix?: string;
  /** Delete only resources carrying every one of these tags and not in this import — one collection's or product's worth. */
  pruneTags?: string[];
  enqueue?: boolean;
};

/**
 * Queue what is missing, stale, rejected or failed — project-wide or within a scope; `force` re-queues
 * translated values too. `statuses` narrows that to the given ones, e.g. `['rejected']`.
 */
export type TranslateOptions = ResourceScope & { locales?: string[]; statuses?: TargetStatus[]; force?: boolean };

export type TranslationRow = {
  id: string;
  key: ResourceKey;
  source: string;
  tags: string[];
  meta: Record<string, unknown>;
  translatable: boolean;
  locale: string;
  value: string | null;
  status: TargetStatus;
  origin: TargetOrigin | null;
  pinned: boolean;
  native: boolean;
  updatedAt: string;
};

export type TranslationsPage = { page: number; limit: number; hasMore: boolean; docs: TranslationRow[] };

export type TranslationsQuery = {
  locale?: string;
  /** Only resources whose key starts with this — one document's worth. */
  prefix?: string;
  /** Only targets changed after this instant — what a delta pull passes. */
  updatedSince?: Date | string;
  page?: number;
  limit?: number;
};

export type StatusCounts = Partial<Record<TargetStatus, number>>;

export type ProjectInfo = ProjectRef & {
  id: string;
  glossary: { term: string; translations: Record<string, string> }[];
  extraInstructions: Record<string, string>;
  debounceSeconds: number;
  counts: { resources: number; targets: StatusCounts };
};

/**
 * Where a scope stands: its targets by status, and one hash over every translated value in it —
 * "done" is no target pending, queued or translating; a changed digest is "different from last time".
 * `digest` is `null` while nothing is translated.
 */
export type ScopeStatus = { counts: StatusCounts; digest: string | null };

/** `by: 'tag'` groups targets under every tag starting with `tagPrefix`; `by: 'locale'` under their locale. */
export type CountsQuery = { by: 'tag' | 'locale'; tagPrefix?: string; prefix?: string };

export type CountsResult = { groups: Record<string, StatusCounts> };

export type TargetInfo = {
  id: string;
  resourceId: string;
  locale: string;
  value: string | null;
  status: TargetStatus;
  origin: TargetOrigin | null;
  pinned: boolean;
  native: boolean;
  sourceRevision: string | null;
  lastError: string | null;
  updatedAt: string;
};

export type ResourceInfo = {
  id: string;
  key: ResourceKey;
  source: string;
  sourceRevision: string;
  tags: string[];
  meta: Record<string, unknown>;
  translatable: boolean;
  updatedAt: string;
  targets: Pick<TargetInfo, 'id' | 'locale' | 'status' | 'origin' | 'pinned' | 'native' | 'value' | 'updatedAt'>[];
};

export type ResourcesQuery = { q?: string; prefix?: string; status?: TargetStatus; locale?: string; tag?: string; page?: number; limit?: number };
