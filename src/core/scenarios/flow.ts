import { and, arrayContains, asc, eq } from 'drizzle-orm';
import type { ResolvedConfig } from '../../config';
import type { Db } from '../../db/client';
import { type GuardRule, type Project, type Scenario, resources } from '../../db/schema';
import { type LayerCatalog, type LayerExplain, explainLayers, loadLayerCatalog, matchesScope, type ResolutionScope, scopeOf } from '../layers/resolve';
import type { ValueContext } from '../model/types';
import { buildPromptContext } from '../prompts/context';

export type FlowSample = { resourceId: string | null; key: string; tags: string[]; locale: string };

export type GuardExplain = {
  name: string;
  source: 'config' | 'rule';
  rule: GuardRule | null;
  params: Record<string, unknown>;
  enabled: boolean;
  canRepair: boolean;
};

/** A code stage from `translate.config.ts`; `enabled` is whether it matches the sample. */
export type StageExplain = { name: string; position: number; description: string | null; enabled: boolean };

export type FlowExplain = {
  scenario: Scenario;
  sample: FlowSample;
  processors: { source: string[]; output: string[] };
  /** Layers and code stages are drawn in one chain, ordered by `byPosition`. */
  layers: LayerExplain[];
  stages: StageExplain[];
  guards: GuardExplain[];
};

type SampleResource = { id: string | null; key: string; source: string; tags: string[]; meta: Record<string, unknown> };

/** The first resource that matches the scenario, so the preview renders real prompt context. */
const sampleResource = async (db: Db, scenario: Scenario): Promise<SampleResource> => {
  const [row] = await db
    .select({ id: resources.id, key: resources.key, source: resources.source, tags: resources.tags, meta: resources.meta })
    .from(resources)
    .where(and(eq(resources.projectId, scenario.projectId), scenario.tags.length > 0 ? arrayContains(resources.tags, scenario.tags) : undefined))
    .orderBy(asc(resources.key))
    .limit(1);
  return row ?? { id: null, key: 'sample.key', source: 'Sample text', tags: scenario.tags, meta: {} };
};

/** Layers and prompts that belong to some other scenario are noise here, not "inactive". */
const belongsHere = (row: { scope: string; scopeRef: string | null }, scope: ResolutionScope): boolean =>
  row.scope !== 'scenario' || matchesScope('scenario', row.scopeRef, scope);

const explainGuards = (config: ResolvedConfig, catalog: LayerCatalog, scope: ResolutionScope, ctx: ValueContext): GuardExplain[] => {
  const rules = new Map<string, GuardRule>();
  for (const rule of catalog.guardRules.filter((rule) => matchesScope(rule.scope, rule.scopeRef, scope))) rules.set(rule.guard, rule);
  const fromConfig = config.guards.map((guard) => {
    const rule = rules.get(guard.name);
    rules.delete(guard.name);
    return rule
      ? { name: guard.name, source: 'rule' as const, rule, params: rule.params, enabled: rule.enabled, canRepair: Boolean(guard.repair) }
      : { name: guard.name, source: 'config' as const, rule: null, params: {}, enabled: guard.match(ctx), canRepair: Boolean(guard.repair) };
  });
  const fromRules = [...rules.values()].map((rule) => {
    const kind = config.guardKinds.find((candidate) => candidate.name === rule.guard);
    return { name: rule.guard, source: 'rule' as const, rule, params: rule.params, enabled: rule.enabled, canRepair: kind?.canRepair ?? false };
  });
  return [...fromConfig, ...fromRules];
};

export const explainFlow = async (deps: { db: Db; config: ResolvedConfig }, project: Project, scenario: Scenario): Promise<FlowExplain> => {
  const [catalog, resource] = await Promise.all([loadLayerCatalog(deps.db), sampleResource(deps.db, scenario)]);
  const locale = project.targetLocales[0] ?? 'xx';
  const resourceId = resource.id ?? 'sample';
  // The sample carries every scenario tag, so the scenario itself is always among the matches.
  const scope = scopeOf(catalog, { project, resource: { id: resourceId, tags: resource.tags } });
  const context = buildPromptContext({ project, resource: { ...resource, id: resourceId }, locale, localeNames: deps.config.localeNames, nativeExamples: [] });
  const ctx: ValueContext = { projectSlug: project.slug, sourceLocale: project.sourceLocale, locale, key: resource.key, tags: resource.tags, meta: resource.meta };
  const layers = explainLayers(catalog, scope, context)
    .filter((entry) => belongsHere(entry.layer, scope))
    .map((entry) => ({ ...entry, prompts: entry.prompts.filter((prompt) => belongsHere(prompt.prompt, scope)) }));
  const processors = deps.config.processors.filter((processor) => processor.match(ctx));
  return {
    scenario,
    sample: { resourceId: resource.id, key: resource.key, tags: resource.tags, locale },
    processors: {
      source: processors.filter((processor) => processor.stage === 'source').map((processor) => processor.name),
      output: processors.filter((processor) => processor.stage === 'output').map((processor) => processor.name),
    },
    layers,
    stages: deps.config.stages.map((stage) => ({ name: stage.name, position: stage.position, description: stage.description ?? null, enabled: stage.match(ctx) })),
    guards: explainGuards(deps.config, catalog, scope, ctx),
  };
};
