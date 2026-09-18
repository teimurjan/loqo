import { eq, sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export type GlossaryEntry = { term: string; translations: Record<string, string> };

const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
};

export const projects = pgTable('projects', {
  id: uuid().primaryKey().defaultRandom(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  sourceLocale: text().notNull().default('en'),
  targetLocales: text().array().notNull().default([]),
  glossary: jsonb().$type<GlossaryEntry[]>().notNull().default([]),
  /** Per-locale free-text instructions appended to the translate layer. */
  extraInstructions: jsonb().$type<Record<string, string>>().notNull().default({}),
  /** Cloud Tasks-style debounce: a translation waits this long so rapid edits collapse into one job. */
  debounceSeconds: integer().notNull().default(60),
  ...timestamps,
});

export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  /** Lowercased; the key invites are matched on. */
  email: text().notNull().unique(),
  name: text().notNull(),
  avatarUrl: text(),
  googleSub: text().notNull().unique(),
  ...timestamps,
});

export const sessions = pgTable('sessions', {
  id: uuid().primaryKey().defaultRandom(),
  /** sha256 of the cookie token; the token itself is never stored. */
  tokenHash: text().notNull().unique(),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const memberRole = pgEnum('member_role', ['admin', 'editor', 'reader']);
export type MemberRole = (typeof memberRole.enumValues)[number];

export const projectMembers = pgTable(
  'project_members',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** null until the invited email signs in. */
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    role: memberRole().notNull(),
    invitedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex('project_members_project_email').on(t.projectId, t.email), index('project_members_user').on(t.userId)],
);

/**
 * What a repo's sync step authenticates with. Bound to one project with one role, so a leaked CI
 * key exposes that project alone; the key itself is shown once and only its hash is kept.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** sha256 of the key. */
    keyHash: text().notNull().unique(),
    /** The key's first characters, so a list is recognizable without revealing anything. */
    prefix: text().notNull(),
    role: memberRole().notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index('api_keys_project').on(t.projectId)],
);

export const resources = pgTable(
  'resources',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    source: text().notNull(),
    /** sha256 of source + comment; a target is stale when its own revision differs. */
    sourceRevision: text().notNull(),
    tags: text().array().notNull().default([]),
    meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** `false` mirrors Android `translatable="false"`: every target is skipped. */
    translatable: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('resources_project_key').on(t.projectId, t.key), index('resources_project').on(t.projectId)],
);

export const targetStatus = pgEnum('target_status', [
  'pending',
  'queued',
  'translating',
  'translated',
  'rejected',
  'failed',
  'skipped',
]);
export type TargetStatus = (typeof targetStatus.enumValues)[number];

export const targetOrigin = pgEnum('target_origin', ['machine', 'human', 'legacy']);
export type TargetOrigin = (typeof targetOrigin.enumValues)[number];

export const targets = pgTable(
  'targets',
  {
    id: uuid().primaryKey().defaultRandom(),
    resourceId: uuid()
      .notNull()
      .references(() => resources.id, { onDelete: 'cascade' }),
    locale: text().notNull(),
    value: text(),
    status: targetStatus().notNull().default('pending'),
    origin: targetOrigin(),
    /** Frozen: the pipeline never overwrites it, even when the source changes. */
    pinned: boolean().notNull().default(false),
    /** Human-approved as native quality; also serves as a few-shot example for its locale. */
    native: boolean().notNull().default(false),
    /** The resource revision `value` was produced from. */
    sourceRevision: text(),
    lastError: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('targets_resource_locale').on(t.resourceId, t.locale),
    index('targets_status').on(t.status),
    index('targets_locale').on(t.locale),
  ],
);

export const verdictOutcome = pgEnum('verdict_outcome', ['pass', 'repair', 'reject']);
export type VerdictOutcome = (typeof verdictOutcome.enumValues)[number];

export const verdicts = pgTable(
  'verdicts',
  {
    id: uuid().primaryKey().defaultRandom(),
    targetId: uuid()
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    /** One pipeline attempt; joins `layer_runs.run_id`. */
    runId: uuid().notNull(),
    guard: text().notNull(),
    outcome: verdictOutcome().notNull(),
    detail: text(),
    before: text(),
    after: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('verdicts_target').on(t.targetId)],
);

export const promptScope = pgEnum('prompt_scope', ['default', 'project', 'tag', 'resource', 'scenario']);
export type PromptScope = (typeof promptScope.enumValues)[number];

export const scenarios = pgTable(
  'scenarios',
  {
    id: uuid().primaryKey().defaultRandom(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** A resource matches when it carries every tag; empty means the whole project. */
    tags: text().array().notNull().default([]),
    /** Seeded from `DEFAULT_SCENARIOS`; name and tags are read-only, attachments are not. */
    builtin: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex('scenarios_project_name').on(t.projectId, t.name)],
);

export const layers = pgTable(
  'layers',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    position: integer().notNull(),
    /** `provider:model`, resolved through the AI SDK provider registry. */
    model: text().notNull(),
    reasoningEffort: text(),
    enabled: boolean().notNull().default(true),
    description: text(),
    /** Built-ins are `default`; a scenario-scoped layer only runs for targets matching that scenario. */
    scope: promptScope().notNull().default('default'),
    scopeRef: text(),
    /** Seeded from code and read-only through the API. */
    builtin: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [unique('layers_name_scope').on(t.name, t.scope, t.scopeRef).nullsNotDistinct()],
);

export const prompts = pgTable(
  'prompts',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** `null` attaches the fragment to every layer. */
    layerId: uuid().references(() => layers.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    scope: promptScope().notNull().default('default'),
    /** project slug, tag, resource id or scenario id depending on `scope`; null for `default`. */
    scopeRef: text(),
    position: integer().notNull().default(100),
    enabled: boolean().notNull().default(true),
    builtin: boolean().notNull().default(false),
    ...timestamps,
  },
  (t) => [unique('prompts_name_scope').on(t.name, t.scope, t.scopeRef).nullsNotDistinct()],
);

export const promptVersions = pgTable(
  'prompt_versions',
  {
    id: uuid().primaryKey().defaultRandom(),
    promptId: uuid()
      .notNull()
      .references(() => prompts.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    body: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('prompt_versions_prompt_version').on(t.promptId, t.version)],
);

export const layerOverrides = pgTable(
  'layer_overrides',
  {
    id: uuid().primaryKey().defaultRandom(),
    layerId: uuid()
      .notNull()
      .references(() => layers.id, { onDelete: 'cascade' }),
    scope: promptScope().notNull(),
    scopeRef: text().notNull(),
    model: text(),
    reasoningEffort: text(),
    enabled: boolean(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('layer_overrides_layer_scope').on(t.layerId, t.scope, t.scopeRef)],
);

export const guardRules = pgTable(
  'guard_rules',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Name of a guard kind registered in `translate.config.ts`. */
    guard: text().notNull(),
    scope: promptScope().notNull(),
    scopeRef: text().notNull(),
    params: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** `false` switches a default guard off for matching targets. */
    enabled: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('guard_rules_guard_scope').on(t.guard, t.scope, t.scopeRef)],
);

export const layerRuns = pgTable(
  'layer_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    runId: uuid().notNull(),
    projectId: uuid().references(() => projects.id, { onDelete: 'set null' }),
    locale: text().notNull(),
    layerId: uuid().references(() => layers.id, { onDelete: 'set null' }),
    layerName: text().notNull(),
    /** `layer` for a pipeline step, `repair` for a guard-triggered fix-up call. */
    kind: text().notNull().default('layer'),
    model: text().notNull(),
    promptVersionIds: uuid().array().notNull().default([]),
    targetCount: integer().notNull(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    reasoningTokens: integer().notNull().default(0),
    cachedInputTokens: integer().notNull().default(0),
    /** null when the model has no known price. */
    costUsd: doublePrecision(),
    latencyMs: integer().notNull().default(0),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('layer_runs_project').on(t.projectId), index('layer_runs_created').on(t.createdAt)],
);

export const layerRunTargets = pgTable(
  'layer_run_targets',
  {
    layerRunId: uuid()
      .notNull()
      .references(() => layerRuns.id, { onDelete: 'cascade' }),
    targetId: uuid()
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.layerRunId, t.targetId] }), index('layer_run_targets_target').on(t.targetId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    actor: text().notNull(),
    action: text().notNull(),
    projectId: uuid(),
    resourceId: uuid(),
    targetId: uuid(),
    detail: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_created').on(t.createdAt)],
);

export const priceCache = pgTable('price_cache', {
  id: text().primaryKey(),
  body: jsonb().$type<Record<string, unknown>>().notNull(),
  fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export type Project = typeof projects.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Scenario = typeof scenarios.$inferSelect;
export type GuardRule = typeof guardRules.$inferSelect;
export type Resource = typeof resources.$inferSelect;
export type Target = typeof targets.$inferSelect;
export type Verdict = typeof verdicts.$inferSelect;
export type Layer = typeof layers.$inferSelect;
export type Prompt = typeof prompts.$inferSelect;
export type PromptVersion = typeof promptVersions.$inferSelect;
export type LayerOverride = typeof layerOverrides.$inferSelect;
export type LayerRun = typeof layerRuns.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;

/**
 * Analytics is a SQL view over `layer_runs`: one row per run with the project slug denormalized
 * and the day bucketed, so any dashboard is a GROUP BY away.
 */
export const costSummary = pgView('cost_summary').as((qb) =>
  qb
    .select({
      day: sql<string>`date_trunc('day', ${layerRuns.createdAt})::date`.as('day'),
      projectId: layerRuns.projectId,
      projectSlug: sql<string | null>`${projects.slug}`.as('project_slug'),
      locale: layerRuns.locale,
      layerName: layerRuns.layerName,
      kind: layerRuns.kind,
      model: layerRuns.model,
      targetCount: layerRuns.targetCount,
      inputTokens: layerRuns.inputTokens,
      outputTokens: layerRuns.outputTokens,
      reasoningTokens: layerRuns.reasoningTokens,
      cachedInputTokens: layerRuns.cachedInputTokens,
      costUsd: layerRuns.costUsd,
      latencyMs: layerRuns.latencyMs,
      error: layerRuns.error,
      createdAt: layerRuns.createdAt,
    })
    .from(layerRuns)
    .leftJoin(projects, eq(projects.id, layerRuns.projectId)),
);
