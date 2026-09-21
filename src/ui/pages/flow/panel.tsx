import { useMutation, useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { NodeSheet, Row, Section } from '../../components/flow/panel';
import { ErrorNote } from '../../components/layout';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input, Label, Select, Textarea } from '../../components/ui/input';
import { SheetDescription, SheetTitle } from '../../components/ui/sheet';
import { Switch } from '../../components/ui/switch';
import { api } from '../../lib/api';
import { REASONING_EFFORTS } from '../../../core/layers/service';
import type { FlowNodeData, GuardData, LayerData, PromptData } from './layout';
import { ParamsForm } from './params-form';
import { PromptEditor } from './prompt-editor';

export type PanelContext = { slug: string; scenarioId: string; canEdit: boolean; refresh: () => void };

const DeleteButton = ({ label, onClick, pending }: { label: string; onClick: () => void; pending: boolean }) => (
  <Button variant="outline" size="sm" className="text-destructive" onClick={onClick} disabled={pending}>
    <Trash2 /> {label}
  </Button>
);

// ---------------------------------------------------------------------------------------------

const LayerPanel = ({ data, ctx }: { data: LayerData; ctx: PanelContext }) => {
  const { explain } = data;
  const own = explain.overrides.find((override) => override.scope === 'scenario' && override.scopeRef === ctx.scenarioId);
  const [form, setForm] = useState({
    model: own?.model ?? '',
    reasoningEffort: own?.reasoningEffort ?? '',
    enabled: own?.enabled === null || own?.enabled === undefined ? '' : String(own.enabled),
  });
  const save = useMutation({
    mutationFn: () =>
      api.scenarios.upsertOverride(ctx.slug, ctx.scenarioId, {
        layerId: explain.layer.id,
        model: form.model || null,
        reasoningEffort: form.reasoningEffort || null,
        enabled: form.enabled === '' ? null : form.enabled === 'true',
      }),
    onSuccess: ctx.refresh,
  });
  const clear = useMutation({ mutationFn: () => api.overrides.remove(own?.id ?? ''), onSuccess: ctx.refresh });
  const remove = useMutation({ mutationFn: () => api.layers.remove(explain.layer.id), onSuccess: ctx.refresh });
  const ownLayer = explain.layer.scope === 'scenario';
  const [layerForm, setLayerForm] = useState({ model: explain.layer.model, position: String(explain.layer.position), reasoningEffort: explain.layer.reasoningEffort ?? '' });
  const updateLayer = useMutation({
    mutationFn: () => api.layers.update(explain.layer.id, { model: layerForm.model, position: Number(layerForm.position), reasoningEffort: layerForm.reasoningEffort || null }),
    onSuccess: ctx.refresh,
  });

  return (
    <>
      <SheetTitle className="font-mono">{explain.layer.name}</SheetTitle>
      <SheetDescription>{explain.layer.description ?? (ownLayer ? 'Scenario layer' : 'Built-in layer')}</SheetDescription>
      <Section title="Effective for this scenario">
        <Row label="model">{explain.effective.model}</Row>
        <Row label="reasoning">{explain.effective.reasoningEffort ?? 'default'}</Row>
        <Row label="state">{explain.state}</Row>
        {explain.overrides.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {explain.overrides.map((override) => (
              <Badge key={override.id} variant="info">
                {override.scope}
                {override.model ? ` · ${override.model}` : ''}
                {override.reasoningEffort ? ` · ${override.reasoningEffort}` : ''}
                {override.enabled !== null ? ` · ${override.enabled ? 'on' : 'off'}` : ''}
              </Badge>
            ))}
          </div>
        ) : null}
      </Section>
      {ownLayer && ctx.canEdit ? (
        <Section title="Layer">
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 grid gap-1.5">
              <Label>Model</Label>
              <Input value={layerForm.model} onChange={(e) => setLayerForm({ ...layerForm, model: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label>Position</Label>
              <Input type="number" value={layerForm.position} onChange={(e) => setLayerForm({ ...layerForm, position: e.target.value })} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Reasoning</Label>
            <Select value={layerForm.reasoningEffort} onChange={(e) => setLayerForm({ ...layerForm, reasoningEffort: e.target.value })}>
              <option value="">default</option>
              {REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => updateLayer.mutate()} disabled={updateLayer.isPending}>
              Save
            </Button>
            <DeleteButton label="Delete layer" onClick={() => remove.mutate()} pending={remove.isPending} />
          </div>
          <ErrorNote error={updateLayer.error ?? remove.error} />
        </Section>
      ) : null}
      {ctx.canEdit && !ownLayer ? (
        <Section title="Override for this scenario">
          <div className="grid gap-1.5">
            <Label>Model</Label>
            <Input value={form.model} placeholder={`inherit (${explain.layer.model})`} onChange={(e) => setForm({ ...form, model: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label>Reasoning</Label>
              <Select value={form.reasoningEffort} onChange={(e) => setForm({ ...form, reasoningEffort: e.target.value })}>
                <option value="">inherit</option>
                {REASONING_EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Enabled</Label>
              <Select value={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.value })}>
                <option value="">inherit</option>
                <option value="true">on</option>
                <option value="false">off</option>
              </Select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              Save override
            </Button>
            {own ? <DeleteButton label="Clear" onClick={() => clear.mutate()} pending={clear.isPending} /> : null}
          </div>
          <ErrorNote error={save.error ?? clear.error} />
        </Section>
      ) : null}
    </>
  );
};

// ---------------------------------------------------------------------------------------------

const PromptPanel = ({ data, ctx }: { data: PromptData; ctx: PanelContext }) => {
  const { prompt } = data.prompt;
  const own = prompt.scope === 'scenario' && prompt.scopeRef === ctx.scenarioId;
  const editable = own && ctx.canEdit;
  const [showRendered, setShowRendered] = useState(false);
  const toggle = useMutation({ mutationFn: (enabled: boolean) => api.prompts.update(prompt.id, { enabled }), onSuccess: ctx.refresh });
  const remove = useMutation({ mutationFn: () => api.prompts.remove(prompt.id), onSuccess: ctx.refresh });
  return (
    <>
      <SheetTitle className="font-mono">{prompt.name}</SheetTitle>
      <SheetDescription>
        {prompt.layerId ? `Attached to ${data.layer.layer.name}` : 'Attached to every layer'} · position {prompt.position} ·{' '}
        {prompt.builtin ? 'built-in, read-only' : own ? 'this scenario' : `${prompt.scope} scope`}
      </SheetDescription>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={data.prompt.state === 'active' ? 'success' : 'muted'}>{data.prompt.state}</Badge>
        <Badge variant="muted">v{prompt.version}</Badge>
        {editable ? (
          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            enabled <Switch checked={prompt.enabled} onCheckedChange={(enabled) => toggle.mutate(enabled)} />
          </label>
        ) : null}
      </div>
      <Section title="Template">
        <PromptEditor key={`${prompt.id}:${prompt.version}`} promptId={prompt.id} version={prompt.version} body={prompt.body} readOnly={!editable} onPublished={ctx.refresh} />
      </Section>
      {data.prompt.text ? (
        <Section title="Rendered for sample">
          <Button size="sm" variant="ghost" className="justify-start" onClick={() => setShowRendered((value) => !value)}>
            {showRendered ? 'Hide' : 'Show'}
          </Button>
          {showRendered ? <Textarea className="font-mono text-xs" rows={Math.min(16, data.prompt.text.split('\n').length + 1)} value={data.prompt.text} readOnly /> : null}
        </Section>
      ) : null}
      {editable ? (
        <div>
          <DeleteButton label="Delete prompt" onClick={() => remove.mutate()} pending={remove.isPending} />
          <ErrorNote error={toggle.error ?? remove.error} />
        </div>
      ) : null}
    </>
  );
};

// ---------------------------------------------------------------------------------------------

const GuardPanel = ({ data, ctx }: { data: GuardData; ctx: PanelContext }) => {
  const { guard } = data;
  const config = useQuery({ queryKey: ['config'], queryFn: api.config });
  const kind = config.data?.guardKinds.find((candidate) => candidate.name === guard.name);
  const [params, setParams] = useState<Record<string, unknown>>(guard.params);
  const own = guard.rule?.scope === 'scenario' && guard.rule.scopeRef === ctx.scenarioId ? guard.rule : null;
  const attach = useMutation({
    mutationFn: (enabled: boolean) => api.scenarios.addGuardRule(ctx.slug, ctx.scenarioId, { guard: guard.name, params, enabled }),
    onSuccess: ctx.refresh,
  });
  const update = useMutation({
    mutationFn: (input: { params?: Record<string, unknown>; enabled?: boolean }) => api.guardRules.update(own?.id ?? '', input),
    onSuccess: ctx.refresh,
  });
  const remove = useMutation({ mutationFn: () => api.guardRules.remove(own?.id ?? ''), onSuccess: ctx.refresh });
  const error = attach.error ?? update.error ?? remove.error;

  return (
    <>
      <SheetTitle className="font-mono">{guard.name}</SheetTitle>
      <SheetDescription>{kind?.description ?? 'Guard from translate.config.ts'}</SheetDescription>
      <div className="flex flex-wrap gap-2">
        <Badge variant={guard.enabled ? 'success' : 'muted'}>{guard.enabled ? 'runs' : 'off'}</Badge>
        <Badge variant={guard.source === 'rule' ? 'info' : 'muted'}>{guard.source === 'rule' ? `rule · ${guard.rule?.scope}` : 'config default'}</Badge>
        {guard.canRepair ? <Badge variant="warning">repairs</Badge> : null}
      </div>
      {kind ? (
        <Section title="Parameters">
          <ParamsForm schema={kind.schema} value={params} onChange={setParams} disabled={!ctx.canEdit} />
        </Section>
      ) : null}
      {ctx.canEdit ? (
        <Section title="This scenario">
          <div className="flex flex-wrap gap-2">
            {own ? (
              <>
                <Button size="sm" onClick={() => update.mutate({ params })} disabled={update.isPending || !kind}>
                  Save parameters
                </Button>
                <Button size="sm" variant="outline" onClick={() => update.mutate({ enabled: !own.enabled })} disabled={update.isPending}>
                  {own.enabled ? 'Switch off' : 'Switch on'}
                </Button>
                <DeleteButton label="Remove rule" onClick={() => remove.mutate()} pending={remove.isPending} />
              </>
            ) : (
              <>
                <Button size="sm" onClick={() => attach.mutate(true)} disabled={attach.isPending}>
                  {guard.source === 'config' ? 'Override parameters' : 'Attach here'}
                </Button>
                {guard.enabled ? (
                  <Button size="sm" variant="outline" onClick={() => attach.mutate(false)} disabled={attach.isPending}>
                    Switch off for this scenario
                  </Button>
                ) : null}
              </>
            )}
          </div>
          <ErrorNote error={error} />
        </Section>
      ) : null}
    </>
  );
};

// ---------------------------------------------------------------------------------------------

const InfoPanel = ({ title, rows }: { title: string; rows: { label: string; value: string }[] }) => (
  <>
    <SheetTitle>{title}</SheetTitle>
    <SheetDescription>Value processors are code; they run for every matching target.</SheetDescription>
    <Section title="Details">
      {rows.map((row) => (
        <Row key={row.label} label={row.label}>
          {row.value}
        </Row>
      ))}
    </Section>
  </>
);

export const NodePanel = ({ data, ctx, onClose }: { data: FlowNodeData | null; ctx: PanelContext; onClose: () => void }) => (
  <NodeSheet open={data !== null} onClose={onClose}>
    {data?.kind === 'layer' ? <LayerPanel key={data.explain.layer.id} data={data} ctx={ctx} /> : null}
    {data?.kind === 'prompt' ? <PromptPanel key={data.prompt.prompt.id} data={data} ctx={ctx} /> : null}
    {data?.kind === 'guard' ? <GuardPanel key={guardKey(data)} data={data} ctx={ctx} /> : null}
    {data?.kind === 'stage' ? (
      <InfoPanel
        title={data.stage.name}
        rows={[
          { label: 'kind', value: 'code stage (translate.config.ts)' },
          { label: 'position', value: String(data.stage.position) },
          { label: 'description', value: data.stage.description ?? '—' },
          { label: 'state', value: data.stage.enabled ? 'runs for this sample' : 'does not match this sample' },
        ]}
      />
    ) : null}
    {data?.kind === 'source' ? (
      <InfoPanel
        title="Source"
        rows={[
          { label: 'sample', value: data.sample.resourceId ? data.sample.key : 'synthetic' },
          { label: 'tags', value: data.sample.tags.join(', ') || '—' },
          { label: 'processors', value: data.processors.join(', ') || '—' },
        ]}
      />
    ) : null}
    {data?.kind === 'target' ? (
      <InfoPanel
        title="Target"
        rows={[
          { label: 'locale', value: data.locale },
          { label: 'processors', value: data.processors.join(', ') || '—' },
        ]}
      />
    ) : null}
  </NodeSheet>
);

const guardKey = (data: GuardData): string => `${data.guard.name}:${data.guard.rule?.id ?? 'config'}:${data.guard.rule?.updatedAt ?? ''}`;
