import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Background, type NodeMouseHandler, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow } from '@xyflow/react';
import { Pencil, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Empty, ErrorNote } from '../../components/layout';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Label, Select } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import type { FlowExplain } from '../../../core/scenarios/flow';
import { AddGuardDialog, AddLayerDialog, AddPromptDialog, ScenarioDialog } from './dialogs';
import { type FlowNode, layoutFlow } from './layout';
import { nodeTypes } from './nodes';
import { NodePanel, type PanelContext } from './panel';

type CanvasProps = { flow: FlowExplain; showInactive: boolean; sourceLocale: string; selectedId: string | null; onSelect: (id: string | null) => void };

/** Nodes are derived, not owned by React Flow, so selection is painted from the page's state. */
const Canvas = ({ flow, showInactive, sourceLocale, selectedId, onSelect }: CanvasProps) => {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const { nodes, edges } = useMemo(() => layoutFlow(flow, showInactive, sourceLocale), [flow, showInactive, sourceLocale]);
  const painted = useMemo(() => nodes.map((node) => ({ ...node, selected: node.id === selectedId })) as FlowNode[], [nodes, selectedId]);
  // The `fitView` prop covers the first paint. Later layouts (scenario switch, inactive toggle) re-fit
  // once React Flow has measured the new nodes and on the next frame: fitting while its resize
  // observers are still delivering trips "ResizeObserver loop completed with undelivered notifications".
  useEffect(() => {
    if (!nodesInitialized) return;
    const frame = requestAnimationFrame(() => void fitView({ padding: 0.2, duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [fitView, nodes, nodesInitialized]);
  const onNodeClick: NodeMouseHandler<FlowNode> = (_event, node) => onSelect(node.id);
  return (
    <ReactFlow<FlowNode>
      nodes={painted}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      onPaneClick={() => onSelect(null)}
      nodesConnectable={false}
      nodesDraggable={false}
      fitView
      minZoom={0.3}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} />
    </ReactFlow>
  );
};

export const LayersPage = () => {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects.list });
  const slug = params.get('project') ?? projects.data?.[0]?.slug ?? '';
  const project = projects.data?.find((candidate) => candidate.slug === slug);
  const scenarios = useQuery({ queryKey: ['scenarios', slug], queryFn: () => api.scenarios.list(slug), enabled: slug !== '' });
  const scenarioId = params.get('scenario') ?? scenarios.data?.[0]?.id ?? '';
  const scenario = scenarios.data?.find((candidate) => candidate.id === scenarioId);
  const flow = useQuery({ queryKey: ['flow', slug, scenarioId], queryFn: () => api.scenarios.flow(slug, scenarioId), enabled: slug !== '' && scenarioId !== '' });
  const [showInactive, setShowInactive] = useState(false);
  const [selected, setSelected] = useState<{ id: string } | null>(null);
  const canEdit = useCan(slug, 'admin');

  const select = (patch: { project?: string; scenario?: string | null }) => {
    const next = new URLSearchParams(params);
    if (patch.project !== undefined) {
      next.set('project', patch.project);
      next.delete('scenario');
    }
    if (patch.scenario === null) next.delete('scenario');
    else if (patch.scenario !== undefined) next.set('scenario', patch.scenario);
    setParams(next);
  };
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['flow', slug, scenarioId] });
    void queryClient.invalidateQueries({ queryKey: ['scenarios', slug] });
  };
  const removeScenario = useMutation({
    mutationFn: () => api.scenarios.remove(slug, scenarioId),
    onSuccess: () => {
      select({ scenario: null });
      refresh();
    },
  });

  // The selection survives refetches: it is re-derived from the latest layout by node id.
  const selectedData = useMemo(() => {
    if (!selected || !flow.data || !project) return null;
    return layoutFlow(flow.data, true, project.sourceLocale).nodes.find((node) => node.id === selected.id)?.data ?? null;
  }, [selected, flow.data, project]);

  const panel: PanelContext = { slug, scenarioId, canEdit, refresh };

  if (projects.isPending) return null;
  if (projects.data?.length === 0) return <Empty>You are not a member of any project yet.</Empty>;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="flow-project">Project</Label>
          <Select id="flow-project" value={slug} onChange={(e) => select({ project: e.target.value })}>
            {projects.data?.map((candidate) => (
              <option key={candidate.slug} value={candidate.slug}>
                {candidate.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="flow-scenario">Scenario</Label>
          <div className="flex items-center gap-1">
            <Select id="flow-scenario" value={scenarioId} onChange={(e) => select({ scenario: e.target.value })} disabled={!scenarios.data?.length}>
              {scenarios.data?.length ? null : <option value="">no scenarios</option>}
              {scenarios.data?.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                  {candidate.tags.length ? ` · ${candidate.tags.join(', ')}` : ''}
                </option>
              ))}
            </Select>
            {scenario?.builtin ? <Badge variant="muted">built-in</Badge> : null}
            {canEdit && scenario && !scenario.builtin ? (
              <>
                <ScenarioDialog
                  key={scenario.id + scenario.updatedAt.toString()}
                  slug={slug}
                  scenario={scenario}
                  trigger={
                    <Button variant="ghost" size="icon" title="Edit scenario">
                      <Pencil />
                    </Button>
                  }
                  onSaved={refresh}
                />
                <Button variant="ghost" size="icon" title="Delete scenario" onClick={() => removeScenario.mutate()} disabled={removeScenario.isPending}>
                  <Trash2 />
                </Button>
              </>
            ) : null}
            {canEdit && slug ? (
              <ScenarioDialog
                key={`new:${slug}`}
                slug={slug}
                trigger={
                  <Button variant="outline" size="sm">
                    New scenario
                  </Button>
                }
                onSaved={(saved) => {
                  select({ scenario: saved.id });
                  refresh();
                }}
              />
            ) : null}
          </div>
        </div>
        <label className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={showInactive} onCheckedChange={setShowInactive} /> show inactive
        </label>
        {canEdit && scenarioId && flow.data ? (
          <div className="ml-auto flex items-center gap-2">
            <AddLayerDialog slug={slug} scenarioId={scenarioId} layers={flow.data.layers} onSaved={refresh} />
            <AddPromptDialog slug={slug} scenarioId={scenarioId} layers={flow.data.layers} onSaved={refresh} />
            <AddGuardDialog slug={slug} scenarioId={scenarioId} onSaved={refresh} />
          </div>
        ) : null}
      </div>
      <ErrorNote error={flow.error ?? scenarios.error ?? removeScenario.error} />
      {flow.data && project ? (
        <p className="text-xs text-muted-foreground">
          Previewing with {flow.data.sample.resourceId ? <span className="font-mono">{flow.data.sample.key}</span> : 'a synthetic sample'} → {flow.data.sample.locale}. Click a node for details.
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-muted/20">
        {!scenarioId ? (
          <div className="flex h-full items-center justify-center">
            <Empty>{canEdit ? 'Create a scenario to see which layers, prompts and guards run for it.' : 'No scenarios in this project yet.'}</Empty>
          </div>
        ) : flow.data && project ? (
          <ReactFlowProvider>
            <Canvas
              flow={flow.data}
              showInactive={showInactive}
              sourceLocale={project.sourceLocale}
              selectedId={selected?.id ?? null}
              onSelect={(id) => setSelected(id ? { id } : null)}
            />
          </ReactFlowProvider>
        ) : null}
      </div>
      <NodePanel data={selectedData} ctx={panel} onClose={() => setSelected(null)} />
    </div>
  );
};
