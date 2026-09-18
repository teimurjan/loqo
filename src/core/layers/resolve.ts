import { createHash } from 'node:crypto';
import { asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  type GuardRule,
  type Layer,
  type LayerOverride,
  type Prompt,
  type PromptScope,
  type Scenario,
  guardRules,
  layers,
  layerOverrides,
  promptVersions,
  prompts,
  scenarios,
} from '../../db/schema';
import { byPosition } from '../pipeline/order';
import { compileTemplate, type TemplateContext } from '../prompts/template';
import { scenarioIdsFor } from '../scenarios/service';

export type CompiledPrompt = Prompt & { versionId: string; version: number; body: string; render: (context: TemplateContext) => string };

export type LayerCatalog = {
  layers: Layer[];
  prompts: CompiledPrompt[];
  overrides: LayerOverride[];
  scenarios: Scenario[];
  guardRules: GuardRule[];
};

/** Everything the resolver needs, read once per worker tick. */
export const loadLayerCatalog = async (db: Db): Promise<LayerCatalog> => {
  const [layerRows, promptRows, overrideRows, scenarioRows, ruleRows] = await Promise.all([
    db.select().from(layers).orderBy(asc(layers.position), asc(layers.name)),
    db.select().from(prompts).orderBy(asc(prompts.position), asc(prompts.name)),
    db.select().from(layerOverrides),
    db.select().from(scenarios),
    db.select().from(guardRules),
  ]);
  const compiled: CompiledPrompt[] = [];
  for (const prompt of promptRows) {
    const [current] = await db
      .select()
      .from(promptVersions)
      .where(eq(promptVersions.promptId, prompt.id))
      .orderBy(desc(promptVersions.version))
      .limit(1);
    if (!current) continue;
    compiled.push({ ...prompt, versionId: current.id, version: current.version, body: current.body, render: compileTemplate(current.body) });
  }
  return { layers: layerRows, prompts: compiled, overrides: overrideRows, scenarios: scenarioRows, guardRules: ruleRows };
};

export type ResolutionScope = { projectSlug: string; tags: string[]; resourceId: string; scenarioIds: string[] };

export const scopeOf = (
  catalog: Pick<LayerCatalog, 'scenarios'>,
  job: { project: { id: string; slug: string }; resource: { id: string; tags: string[] } },
): ResolutionScope => ({
  projectSlug: job.project.slug,
  tags: job.resource.tags,
  resourceId: job.resource.id,
  scenarioIds: scenarioIdsFor(catalog.scenarios, { projectId: job.project.id, tags: job.resource.tags }),
});

export const SCOPE_RANK: Record<PromptScope, number> = { default: 0, project: 1, tag: 2, scenario: 3, resource: 4 };

export const matchesScope = (scope: PromptScope, scopeRef: string | null, target: ResolutionScope): boolean => {
  switch (scope) {
    case 'default':
      return true;
    case 'project':
      return scopeRef === target.projectSlug;
    case 'tag':
      return scopeRef !== null && target.tags.includes(scopeRef);
    case 'scenario':
      return scopeRef !== null && target.scenarioIds.includes(scopeRef);
    case 'resource':
      return scopeRef === target.resourceId;
  }
};

export type PromptState = 'active' | 'disabled' | 'out-of-scope' | 'empty';
export type PromptExplain = { prompt: Omit<CompiledPrompt, 'render'>; state: PromptState; text: string | null };

export type LayerState = 'active' | 'disabled' | 'out-of-scope' | 'no-prompts';
export type EffectiveLayer = { model: string; reasoningEffort: string | null; enabled: boolean };
export type LayerExplain = { layer: Layer; state: LayerState; effective: EffectiveLayer; overrides: LayerOverride[]; prompts: PromptExplain[] };

const explainPrompt = (prompt: CompiledPrompt, scope: ResolutionScope, context: TemplateContext): PromptExplain => {
  const { render, ...meta } = prompt;
  if (!prompt.enabled) return { prompt: meta, state: 'disabled', text: null };
  if (!matchesScope(prompt.scope, prompt.scopeRef, scope)) return { prompt: meta, state: 'out-of-scope', text: null };
  const text = render(context).trim();
  return text.length === 0 ? { prompt: meta, state: 'empty', text: null } : { prompt: meta, state: 'active', text };
};

/**
 * The full story of one target's pipeline, layer by layer — what the worker runs and what the flow
 * page draws are the same structure. Model and reasoning effort: the most specific override wins
 * per field (resource → scenario → tag → project → layer default). Prompt: every enabled fragment
 * whose scope matches, in position order — fragments add up, they do not replace each other. A
 * layer with nothing to say for this target is skipped.
 */
export const explainLayers = (catalog: LayerCatalog, scope: ResolutionScope, context: TemplateContext): LayerExplain[] =>
  [...catalog.layers].sort(byPosition).map((layer) => {
    const overrides = catalog.overrides
      .filter((override) => override.layerId === layer.id && matchesScope(override.scope, override.scopeRef, scope))
      .sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]);
    const effective = overrides.reduce<EffectiveLayer>(
      (current, override) => ({
        model: override.model ?? current.model,
        reasoningEffort: override.reasoningEffort ?? current.reasoningEffort,
        enabled: override.enabled ?? current.enabled,
      }),
      { model: layer.model, reasoningEffort: layer.reasoningEffort, enabled: layer.enabled },
    );
    const prompts = catalog.prompts
      .filter((prompt) => prompt.layerId === null || prompt.layerId === layer.id)
      .sort(byPosition)
      .map((prompt) => explainPrompt(prompt, scope, context));
    const state: LayerState = !matchesScope(layer.scope, layer.scopeRef, scope)
      ? 'out-of-scope'
      : !effective.enabled
        ? 'disabled'
        : prompts.some((prompt) => prompt.state === 'active')
          ? 'active'
          : 'no-prompts';
    return { layer, state, effective, overrides, prompts };
  });

export type ResolvedLayer = {
  layerId: string;
  name: string;
  /** Where the layer sits among the code stages of `translate.config.ts`. */
  position: number;
  model: string;
  reasoningEffort: string | null;
  systemPrompt: string;
  promptVersionIds: string[];
};

const toResolved = ({ layer, effective, prompts }: LayerExplain): ResolvedLayer => {
  const active = prompts.filter((prompt) => prompt.state === 'active');
  return {
    layerId: layer.id,
    name: layer.name,
    position: layer.position,
    model: effective.model,
    reasoningEffort: effective.reasoningEffort,
    systemPrompt: active.map((prompt) => prompt.text).join('\n\n'),
    promptVersionIds: active.map((prompt) => prompt.prompt.versionId),
  };
};

/** The layers that actually run for a target, in order: the active projection of `explainLayers`. */
export const resolveLayers = (catalog: LayerCatalog, scope: ResolutionScope, context: TemplateContext): ResolvedLayer[] =>
  explainLayers(catalog, scope, context)
    .filter((entry) => entry.state === 'active')
    .map(toResolved);

/** Targets whose resolved layers are byte-identical can share one model call. */
export const layersSignature = (resolved: ResolvedLayer[]): string =>
  createHash('sha256')
    .update(JSON.stringify(resolved.map((layer) => [layer.layerId, layer.model, layer.reasoningEffort, layer.systemPrompt])))
    .digest('hex');
