import type { Edge, Node } from '@xyflow/react';
import type { ResourceDetail, TargetDetail } from '../../../core/resources/service';
import type { LayerRun, Verdict } from '../../../db/schema';

/** `targets` are the rows on the canvas, which a filter may narrow below the resource's own. */
export type SourceData = { kind: 'source'; resource: ResourceDetail; targets: TargetDetail[] };
export type RunData = { kind: 'run'; target: TargetDetail; run: LayerRun };
export type VerdictsData = { kind: 'verdicts'; target: TargetDetail; verdicts: Verdict[] };
export type TargetData = { kind: 'target'; resource: ResourceDetail; target: TargetDetail };

export type ResourceNode = Node<SourceData, 'source'> | Node<RunData, 'run'> | Node<VerdictsData, 'verdicts'> | Node<TargetData, 'target'>;

export type ResourceNodeData = ResourceNode['data'];

export type Attempt = { runId: string; runs: LayerRun[]; verdicts: Verdict[]; startedAt: Date | undefined };

export const SOURCE_NODE_ID = 'source';

const COLUMN_PITCH = 330;
const ROW_PITCH = 110;

export const isStale = (resource: ResourceDetail, target: TargetDetail): boolean => target.value !== null && target.sourceRevision !== resource.sourceRevision;

export const isInProgress = (target: TargetDetail): boolean => target.status === 'pending' || target.status === 'queued' || target.status === 'translating';

const byCreatedAt = <T extends { createdAt: Date | string }>(a: T, b: T): number => String(a.createdAt).localeCompare(String(b.createdAt));

/** One pipeline pass per `runId`, newest first. A hand-written target has none. */
export const attemptsOf = (target: TargetDetail): Attempt[] => {
  const runIds = [...new Set([...target.runs.map((run) => run.runId), ...target.verdicts.map((verdict) => verdict.runId)])];
  return runIds
    .map((runId) => ({
      runId,
      runs: target.runs.filter((run) => run.runId === runId).sort(byCreatedAt),
      verdicts: target.verdicts.filter((verdict) => verdict.runId === runId).sort(byCreatedAt),
    }))
    .map((attempt) => ({ ...attempt, startedAt: attempt.runs[0]?.createdAt ?? attempt.verdicts[0]?.createdAt }))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
};

type Step = { kind: 'run'; run: LayerRun } | { kind: 'verdicts'; verdicts: Verdict[] };

/**
 * What one attempt did, in order: the layer calls, then every guard's verdict, then the repair
 * calls the guards asked for. An attempt's verdicts are written in one insert and share a
 * timestamp, so they are summarised in one step instead of being interleaved with the repairs.
 */
const stepsOf = (attempt: Attempt | undefined): Step[] => {
  if (!attempt) return [];
  const layers = attempt.runs.filter((run) => run.kind !== 'repair');
  const repairs = attempt.runs.filter((run) => run.kind === 'repair');
  const verdicts: Step[] = attempt.verdicts.length > 0 ? [{ kind: 'verdicts', verdicts: attempt.verdicts }] : [];
  return [...layers.map((run): Step => ({ kind: 'run', run })), ...verdicts, ...repairs.map((run): Step => ({ kind: 'run', run }))];
};

export const targetNodeId = (targetId: string): string => `target:${targetId}`;
const runNodeId = (targetId: string, runId: string): string => `run:${targetId}:${runId}`;
const verdictsNodeId = (targetId: string): string => `verdicts:${targetId}`;

const edge = (from: string, to: string, target: TargetDetail): Edge => ({
  id: `${from}->${to}`,
  source: from,
  target: to,
  animated: isInProgress(target),
  style: target.status === 'skipped' ? { opacity: 0.35 } : undefined,
});

/**
 * One row per locale, fanning out from the source: each row is the latest attempt's steps and
 * ends in the target, with every target on the same column so the outcomes line up. Positions
 * are computed from the ledger, never stored.
 */
export const layoutResource = (resource: ResourceDetail, targets: TargetDetail[]): { nodes: ResourceNode[]; edges: Edge[] } => {
  const chains = targets.map((target) => ({ target, steps: stepsOf(attemptsOf(target)[0]) }));
  const depth = Math.max(0, ...chains.map((chain) => chain.steps.length));
  const column = (index: number) => index * COLUMN_PITCH;
  const nodes: ResourceNode[] = [
    { id: SOURCE_NODE_ID, type: 'source', position: { x: 0, y: (Math.max(chains.length, 1) - 1) * (ROW_PITCH / 2) }, data: { kind: 'source', resource, targets } },
  ];
  const edges: Edge[] = [];

  chains.forEach(({ target, steps }, row) => {
    const y = row * ROW_PITCH;
    let previous = SOURCE_NODE_ID;
    steps.forEach((step, index) => {
      const position = { x: column(index + 1), y };
      if (step.kind === 'run') {
        const id = runNodeId(target.id, step.run.id);
        nodes.push({ id, type: 'run', position, data: { kind: 'run', target, run: step.run } });
        edges.push(edge(previous, id, target));
        previous = id;
        return;
      }
      const id = verdictsNodeId(target.id);
      nodes.push({ id, type: 'verdicts', position, data: { kind: 'verdicts', target, verdicts: step.verdicts } });
      edges.push(edge(previous, id, target));
      previous = id;
    });
    const id = targetNodeId(target.id);
    nodes.push({ id, type: 'target', position: { x: column(depth + 1), y }, data: { kind: 'target', resource, target } });
    edges.push(edge(previous, id, target));
  });

  return { nodes, edges };
};
