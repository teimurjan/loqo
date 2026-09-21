import type { Edge, Node } from '@xyflow/react';
import type { LayerExplain, PromptExplain } from '../../../core/layers/resolve';
import { byPosition } from '../../../core/pipeline/order';
import type { FlowExplain, FlowSample, GuardExplain, StageExplain } from '../../../core/scenarios/flow';

export type SourceData = { kind: 'source'; sample: FlowSample; sourceLocale: string; processors: string[] };
export type LayerData = { kind: 'layer'; explain: LayerExplain };
export type StageData = { kind: 'stage'; stage: StageExplain };
export type PromptData = { kind: 'prompt'; layer: LayerExplain; prompt: PromptExplain };
export type GuardData = { kind: 'guard'; guard: GuardExplain };
export type TargetData = { kind: 'target'; processors: string[]; locale: string };

export type FlowNode =
  | Node<SourceData, 'source'>
  | Node<LayerData, 'layer'>
  | Node<StageData, 'stage'>
  | Node<PromptData, 'prompt'>
  | Node<GuardData, 'guard'>
  | Node<TargetData, 'target'>;

export type FlowNodeData = FlowNode['data'];

export const NODE_WIDTH = 260;
const COLUMN_PITCH = 330;
const ROW_PITCH = 84;
const PROMPT_OFFSET = 120;

export const layerNodeId = (layerId: string): string => `layer:${layerId}`;
export const stageNodeId = (name: string): string => `stage:${name}`;
export const promptNodeId = (layerId: string, promptId: string): string => `prompt:${layerId}:${promptId}`;
export const guardNodeId = (name: string): string => `guard:${name}`;

const edge = (source: string, target: string, extra: Partial<Edge> = {}): Edge => ({ id: `${source}->${target}`, source, target, ...extra });

const isActiveLayer = (layer: LayerExplain): boolean => layer.state === 'active';

type Step = { kind: 'layer'; layer: LayerExplain } | { kind: 'stage'; stage: StageExplain };

const positionOf = (step: Step) => (step.kind === 'layer' ? step.layer.layer : step.stage);

/** Another scenario's layer, or a code stage whose matcher rejects the sample, has nothing to show here. */
const belongsHere = (step: Step): boolean => (step.kind === 'layer' ? step.layer.state !== 'out-of-scope' : step.stage.enabled);

/** The chain the worker runs: layers and code stages interleaved by the pipeline's own ordering. */
const stepsOf = (flow: FlowExplain): Step[] =>
  [...flow.layers.map((layer): Step => ({ kind: 'layer', layer })), ...flow.stages.map((stage): Step => ({ kind: 'stage', stage }))].sort((a, b) =>
    byPosition(positionOf(a), positionOf(b)),
  );

/**
 * Column layout of the pipeline: source → each step (a layer with its prompts stacked beneath,
 * or a code stage) → every guard → target. What belongs to this scenario is always drawn, dimmed
 * when switched off, so a disabled layer, prompt or guard stays reachable to switch back on;
 * what belongs to another scenario is left out. Positions are computed, never stored, so the
 * canvas can't drift from what the worker actually resolves. Node type names avoid React Flow's
 * built-in `input`, `output` and `default`, which its stylesheet paints as plain white cards.
 */
export const layoutFlow = (flow: FlowExplain, sourceLocale: string): { nodes: FlowNode[]; edges: Edge[] } => {
  const steps = stepsOf(flow).filter(belongsHere);
  const nodes: FlowNode[] = [];
  const edges: Edge[] = [];
  const column = (index: number) => index * COLUMN_PITCH;

  nodes.push({ id: 'source', type: 'source', position: { x: 0, y: 0 }, data: { kind: 'source', sample: flow.sample, sourceLocale, processors: flow.processors.source } });

  let previous = 'source';
  steps.forEach((step, index) => {
    if (step.kind === 'stage') {
      const id = stageNodeId(step.stage.name);
      nodes.push({ id, type: 'stage', position: { x: column(index + 1), y: 0 }, data: { kind: 'stage', stage: step.stage } });
      edges.push(edge(previous, id, { animated: step.stage.enabled }));
      previous = id;
      return;
    }
    const { layer } = step;
    const id = layerNodeId(layer.layer.id);
    nodes.push({ id, type: 'layer', position: { x: column(index + 1), y: 0 }, data: { kind: 'layer', explain: layer } });
    edges.push(edge(previous, id, { animated: isActiveLayer(layer) }));
    previous = id;
    layer.prompts
      .filter((prompt) => prompt.state !== 'out-of-scope')
      .forEach((prompt, row) => {
        const promptId = promptNodeId(layer.layer.id, prompt.prompt.id);
        nodes.push({ id: promptId, type: 'prompt', position: { x: column(index + 1), y: PROMPT_OFFSET + row * ROW_PITCH }, data: { kind: 'prompt', layer, prompt } });
        edges.push(edge(promptId, id, { targetHandle: 'prompts', style: prompt.state === 'active' ? undefined : { opacity: 0.35 } }));
      });
  });

  const guardColumn = column(steps.length + 1);
  const outputId = 'target';
  const outputColumn = column(steps.length + (flow.guards.length > 0 ? 2 : 1));
  flow.guards.forEach((guard, row) => {
    const id = guardNodeId(guard.name);
    nodes.push({ id, type: 'guard', position: { x: guardColumn, y: row * ROW_PITCH }, data: { kind: 'guard', guard } });
    edges.push(edge(previous, id, { style: guard.enabled ? undefined : { opacity: 0.35 } }));
    edges.push(edge(id, outputId, { style: guard.enabled ? undefined : { opacity: 0.35 } }));
  });
  if (flow.guards.length === 0) edges.push(edge(previous, outputId));

  nodes.push({ id: outputId, type: 'target', position: { x: outputColumn, y: 0 }, data: { kind: 'target', processors: flow.processors.output, locale: flow.sample.locale } });
  return { nodes, edges };
};
