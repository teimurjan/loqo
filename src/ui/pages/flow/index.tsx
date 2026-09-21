import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { FlowCanvas } from '../../components/flow/canvas';
import { Empty, ErrorNote, PageHeader } from '../../components/layout';
import { Button } from '../../components/ui/button';
import { Label, Select } from '../../components/ui/input';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { AddGuardDialog, AddLayerDialog, AddPromptDialog, ScenarioDialog } from './dialogs';
import { layoutFlow } from './layout';
import { nodeTypes } from './nodes';
import { NodePanel, type PanelContext } from './panel';

export const LayersPage = () => {
  const { slug = '' } = useParams();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const project = useQuery({ queryKey: ['project', slug], queryFn: () => api.projects.get(slug) });
  const scenarios = useQuery({ queryKey: ['scenarios', slug], queryFn: () => api.scenarios.list(slug) });
  const scenarioId = params.get('scenario') ?? scenarios.data?.[0]?.id ?? '';
  const scenario = scenarios.data?.find((candidate) => candidate.id === scenarioId);
  const flow = useQuery({ queryKey: ['flow', slug, scenarioId], queryFn: () => api.scenarios.flow(slug, scenarioId), enabled: scenarioId !== '' });
  const [selected, setSelected] = useState<{ id: string } | null>(null);
  const canEdit = useCan(slug, 'admin');
  const sourceLocale = project.data?.sourceLocale;
  const graph = useMemo(() => (flow.data && sourceLocale ? layoutFlow(flow.data, sourceLocale) : null), [flow.data, sourceLocale]);

  const selectScenario = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id === null) next.delete('scenario');
    else next.set('scenario', id);
    setParams(next);
  };
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['flow', slug, scenarioId] });
    void queryClient.invalidateQueries({ queryKey: ['scenarios', slug] });
  };
  const removeScenario = useMutation({
    mutationFn: () => api.scenarios.remove(slug, scenarioId),
    onSuccess: () => {
      selectScenario(null);
      refresh();
    },
  });

  // The selection survives refetches: it is re-derived from the latest layout by node id.
  const selectedData = useMemo(() => (selected ? (graph?.nodes.find((node) => node.id === selected.id)?.data ?? null) : null), [selected, graph]);

  const panel: PanelContext = { slug, scenarioId, canEdit, refresh };

  if (!project.data) return <ErrorNote error={project.error} />;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Layers"
        description={`${project.data.name} · ${slug}`}
        actions={
          <Button variant="outline" asChild>
            <Link to={`/projects/${slug}`}>
              <ArrowLeft /> Back to project
            </Link>
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="flow-scenario">Scenario</Label>
            <div className="flex items-center gap-1">
              <Select id="flow-scenario" value={scenarioId} onChange={(e) => selectScenario(e.target.value)} disabled={!scenarios.data?.length}>
                {scenarios.data?.length ? null : <option value="">no scenarios</option>}
                {scenarios.data?.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                    {candidate.tags.length ? ` · ${candidate.tags.join(', ')}` : ''}
                  </option>
                ))}
              </Select>
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
              {canEdit ? (
                <ScenarioDialog
                  key={`new:${slug}`}
                  slug={slug}
                  trigger={
                    <Button variant="outline" size="sm">
                      New scenario
                    </Button>
                  }
                  onSaved={(saved) => {
                    selectScenario(saved.id);
                    refresh();
                  }}
                />
              ) : null}
            </div>
          </div>
          {canEdit && scenarioId && flow.data ? (
            <div className="ml-auto flex items-center gap-2">
              <AddLayerDialog slug={slug} scenarioId={scenarioId} layers={flow.data.layers} onSaved={refresh} />
              <AddPromptDialog slug={slug} scenarioId={scenarioId} layers={flow.data.layers} onSaved={refresh} />
              <AddGuardDialog slug={slug} scenarioId={scenarioId} onSaved={refresh} />
            </div>
          ) : null}
        </div>
        <ErrorNote error={flow.error ?? scenarios.error ?? removeScenario.error} />
        {flow.data ? (
          <p className="text-xs text-muted-foreground">
            Previewing with {flow.data.sample.resourceId ? <span className="font-mono">{flow.data.sample.key}</span> : 'a synthetic sample'} → {flow.data.sample.locale}. Click a node for details.
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-muted/20">
          {!scenarioId ? (
            <div className="flex h-full items-center justify-center">
              <Empty>{canEdit ? 'Create a scenario to see which layers, prompts and guards run for it.' : 'No scenarios in this project yet.'}</Empty>
            </div>
          ) : graph ? (
            <FlowCanvas nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} selectedId={selected?.id ?? null} onSelect={(id) => setSelected(id ? { id } : null)} />
          ) : null}
        </div>
      </div>
      <NodePanel data={selectedData} ctx={panel} onClose={() => setSelected(null)} />
    </div>
  );
};
