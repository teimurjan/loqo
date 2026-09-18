import type { Project } from '../../db/schema';
import type { ResolvedLayer } from '../layers/resolve';
import type { ValueContext } from '../model/types';
import type { TokenUsage } from '../pricing';
import { callLayer, type ModelClient } from './llm';
import { byPosition } from './order';

/** One value as a stage sees it: `text` is what the stages before it produced, `source` never changes. */
export type StageField = { id: string; text: string; source: string; ctx: ValueContext };

export type StageInput = { project: Project; locale: string; fields: StageField[] };

export type StageResult = {
  /** New text by field id; a field left out keeps its text. */
  fields?: Record<string, string>;
  /** Fields this stage answered for good — a memory hit, a value that needs no model. Later stages never see them. */
  settled?: string[];
  /** Fields the stage was asked for and could not answer; they are rejected, never shipped as their input. */
  missing?: string[];
  /** Tokens spent, for stages that call a model. */
  usage?: TokenUsage;
};

/**
 * A step of the pipeline. The layers edited in the UI run as stages that call a model; a stage in
 * `translate.config.ts` is code — a translation-memory lookup, a glossary pre-fill, a rule-based
 * post-edit — and takes its place among them by `position` (built-in layers sit at 10 and 20).
 * Stages see every field still in flight that `match` accepts, so a stage that settles some
 * fields and leaves the rest is how a group branches without the caller knowing.
 */
export interface Stage {
  readonly name: string;
  readonly position: number;
  /** One line for the flow page. */
  readonly description?: string;
  /** Set on stages that spend model tokens: what `layer_runs` records besides usage. */
  readonly model?: { ref: string; layerId: string | null; promptVersionIds: string[] };
  match(ctx: ValueContext): boolean;
  run(input: StageInput): Promise<StageResult>;
}

/** A resolved layer, or a repair call standing in for one (no layer row, no prompt versions). */
export type ModelCall = Omit<ResolvedLayer, 'layerId'> & { layerId: string | null };

/** A model call as a stage: every field goes through the envelope, in one request. */
export const llmStage = (models: ModelClient, layer: ModelCall): Stage => ({
  name: layer.name,
  position: layer.position,
  model: { ref: layer.model, layerId: layer.layerId, promptVersionIds: layer.promptVersionIds },
  match: () => true,
  run: async ({ fields }) => {
    const result = await callLayer(models, {
      model: layer.model,
      reasoningEffort: layer.reasoningEffort,
      systemPrompt: layer.systemPrompt,
      fields: Object.fromEntries(fields.map((field) => [field.id, field.text])),
    });
    return { fields: result.fields, missing: result.missing, usage: result.usage };
  },
});

/** The stages one group runs, in order: its resolved layers interleaved with the code stages. */
export const composeStages = (models: ModelClient, stages: Stage[], layers: ResolvedLayer[]): Stage[] =>
  [...layers.map((layer) => llmStage(models, layer)), ...stages].sort(byPosition);
