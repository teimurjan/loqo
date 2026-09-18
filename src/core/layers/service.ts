import { and, desc, eq, isNull, max } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  type Layer,
  type LayerOverride,
  type Prompt,
  type PromptScope,
  type PromptVersion,
  layerOverrides,
  layers,
  promptVersions,
  prompts,
} from '../../db/schema';
import { compileTemplate } from '../prompts/template';
import { DEFAULT_LAYERS, DEFAULT_PROMPTS, type PromptSeed } from './defaults';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Installs the built-in pipeline, plus the prompts `translate.config.ts` owns. Layers and prompts
 * are inserted where nothing exists yet and never overwritten; a code-owned prompt's body, though,
 * is the code's (the API keeps built-ins read-only), so a body that changed in code becomes that
 * prompt's next version.
 */
export const seedDefaults = async (db: Db, configPrompts: PromptSeed[] = []): Promise<{ layers: number; prompts: number }> => {
  let seededLayers = 0;
  let seededPrompts = 0;
  await db.transaction(async (tx) => {
    for (const layer of DEFAULT_LAYERS) {
      const inserted = await tx
        .insert(layers)
        .values({ ...layer, builtin: true })
        .onConflictDoNothing({ target: [layers.name, layers.scope, layers.scopeRef] })
        .returning({ id: layers.id });
      seededLayers += inserted.length;
      // A row with a built-in's name and scope is that built-in, however it was seeded: the flag postdates some of them.
      if (inserted.length === 0) {
        await tx
          .update(layers)
          .set({ builtin: true })
          .where(and(eq(layers.name, layer.name), eq(layers.scope, 'default'), isNull(layers.scopeRef)));
      }
    }
    const layerIds = new Map((await tx.select({ id: layers.id, name: layers.name }).from(layers).where(eq(layers.builtin, true))).map((row) => [row.name, row.id]));
    for (const prompt of [...DEFAULT_PROMPTS, ...configPrompts]) {
      const layerId = prompt.layer ? (layerIds.get(prompt.layer) ?? null) : null;
      if (prompt.layer && !layerId) continue;
      const inserted = await tx
        .insert(prompts)
        .values({ layerId, name: prompt.name, scope: prompt.scope, scopeRef: prompt.scopeRef, position: prompt.position, builtin: true })
        .onConflictDoNothing({ target: [prompts.name, prompts.scope, prompts.scopeRef] })
        .returning({ id: prompts.id });
      const row = inserted[0];
      if (row) {
        await tx.insert(promptVersions).values({ promptId: row.id, version: 1, body: prompt.body });
        seededPrompts += 1;
        continue;
      }
      const [existing] = await tx
        .update(prompts)
        .set({ builtin: true })
        .where(and(eq(prompts.name, prompt.name), eq(prompts.scope, prompt.scope), prompt.scopeRef === null ? isNull(prompts.scopeRef) : eq(prompts.scopeRef, prompt.scopeRef)))
        .returning({ id: prompts.id });
      if (!existing) continue;
      const [latest] = await tx.select({ version: promptVersions.version, body: promptVersions.body }).from(promptVersions).where(eq(promptVersions.promptId, existing.id)).orderBy(desc(promptVersions.version)).limit(1);
      if (latest && latest.body !== prompt.body) {
        await tx.insert(promptVersions).values({ promptId: existing.id, version: latest.version + 1, body: prompt.body });
        seededPrompts += 1;
      }
    }
  });
  return { layers: seededLayers, prompts: seededPrompts };
};

// ---------------------------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------------------------

export type LayerInput = {
  name: string;
  position: number;
  model: string;
  reasoningEffort?: string | null;
  enabled?: boolean;
  description?: string | null;
};

type Scoped = { scope: PromptScope; scopeRef: string | null };

export const getLayer = async (db: Db, id: string): Promise<Layer | null> => {
  const [row] = await db.select().from(layers).where(eq(layers.id, id)).limit(1);
  return row ?? null;
};

export const createLayer = async (db: Db, input: LayerInput & Scoped): Promise<Layer> => {
  const [row] = await db.insert(layers).values(input).returning();
  if (!row) throw new Error('insert returned no row');
  return row;
};

export const updateLayer = async (db: Db, id: string, input: Partial<LayerInput>): Promise<Layer | null> => {
  const [row] = await db
    .update(layers)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(layers.id, id))
    .returning();
  return row ?? null;
};

export const deleteLayer = async (db: Db, id: string): Promise<boolean> =>
  (await db.delete(layers).where(eq(layers.id, id)).returning({ id: layers.id })).length > 0;

// ---------------------------------------------------------------------------------------------
// Prompts (versioned)
// ---------------------------------------------------------------------------------------------

export type PromptWithVersion = Prompt & { version: number; body: string; versionId: string };

export type PromptInput = {
  layerId: string | null;
  name: string;
  position?: number;
  enabled?: boolean;
  body: string;
};

/** A template that does not parse must not be stored: the worker would fail on every target. */
const assertTemplate = (body: string): void => {
  compileTemplate(body);
};

export const getPrompt = async (db: Db, id: string): Promise<PromptWithVersion | null> => {
  const [row] = await db.select().from(prompts).where(eq(prompts.id, id)).limit(1);
  if (!row) return null;
  const [version] = await db.select().from(promptVersions).where(eq(promptVersions.promptId, id)).orderBy(desc(promptVersions.version)).limit(1);
  return version ? { ...row, version: version.version, body: version.body, versionId: version.id } : null;
};

export const createPrompt = async (db: Db, input: PromptInput & Scoped): Promise<PromptWithVersion> => {
  assertTemplate(input.body);
  const { body, ...meta } = input;
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(prompts).values(meta).returning();
    if (!row) throw new Error('insert returned no row');
    const [version] = await tx.insert(promptVersions).values({ promptId: row.id, version: 1, body }).returning();
    if (!version) throw new Error('insert returned no row');
    return { ...row, version: 1, body, versionId: version.id };
  });
};

export const updatePrompt = async (db: Db, id: string, input: Partial<Omit<PromptInput, 'body'>>): Promise<Prompt | null> => {
  const [row] = await db
    .update(prompts)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(prompts.id, id))
    .returning();
  return row ?? null;
};

/** Every edit is a new version; nothing is ever rewritten in place, so old runs stay explainable. */
export const addPromptVersion = async (db: Db, promptId: string, body: string): Promise<PromptVersion> => {
  assertTemplate(body);
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ version: max(promptVersions.version) }).from(promptVersions).where(eq(promptVersions.promptId, promptId));
    const version = (current?.version ?? 0) + 1;
    const [row] = await tx.insert(promptVersions).values({ promptId, version, body }).returning();
    if (!row) throw new Error('insert returned no row');
    await tx.update(prompts).set({ updatedAt: new Date() }).where(eq(prompts.id, promptId));
    return row;
  });
};

export const listPromptVersions = (db: Db, promptId: string): Promise<PromptVersion[]> =>
  db.select().from(promptVersions).where(eq(promptVersions.promptId, promptId)).orderBy(desc(promptVersions.version));

export const deletePrompt = async (db: Db, id: string): Promise<boolean> =>
  (await db.delete(prompts).where(eq(prompts.id, id)).returning({ id: prompts.id })).length > 0;

// ---------------------------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------------------------

export type OverrideInput = {
  layerId: string;
  model?: string | null;
  reasoningEffort?: string | null;
  enabled?: boolean | null;
};

export const getOverride = async (db: Db, id: string): Promise<LayerOverride | null> => {
  const [row] = await db.select().from(layerOverrides).where(eq(layerOverrides.id, id)).limit(1);
  return row ?? null;
};

export const upsertOverride = async (db: Db, input: OverrideInput & { scope: Exclude<PromptScope, 'default'>; scopeRef: string }): Promise<LayerOverride> => {
  const [row] = await db
    .insert(layerOverrides)
    .values(input)
    .onConflictDoUpdate({
      target: [layerOverrides.layerId, layerOverrides.scope, layerOverrides.scopeRef],
      set: { model: input.model ?? null, reasoningEffort: input.reasoningEffort ?? null, enabled: input.enabled ?? null },
    })
    .returning();
  if (!row) throw new Error('upsert returned no row');
  return row;
};

export const deleteOverride = async (db: Db, id: string): Promise<boolean> =>
  (await db.delete(layerOverrides).where(eq(layerOverrides.id, id)).returning({ id: layerOverrides.id })).length > 0;
