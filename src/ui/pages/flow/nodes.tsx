import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Code, FileText, Layers, ShieldCheck, Sparkles, Target } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Badge } from '../../components/ui/badge';
import { cn } from '../../lib/utils';
import type { FlowNode, GuardData, LayerData, PromptData, SourceData, StageData, TargetData } from './layout';

type Props<Data> = NodeProps<Extract<FlowNode, { data: Data }>>;

const Shell = ({ selected, inactive, tone, children }: { selected: boolean; inactive?: boolean; tone: 'neutral' | 'primary' | 'info' | 'warning'; children: ReactNode }) => (
  <div
    className={cn(
      'w-[260px] rounded-lg border bg-card px-3 py-2 text-left text-card-foreground shadow-xs transition-colors',
      tone === 'primary' && 'border-primary/40',
      tone === 'info' && 'border-info/40',
      tone === 'warning' && 'border-warning/50',
      selected && 'ring-2 ring-ring',
      inactive && 'opacity-45 border-dashed',
    )}
  >
    {children}
  </div>
);

const Title = ({ icon, children, right }: { icon: ReactNode; children: ReactNode; right?: ReactNode }) => (
  <div className="flex items-center gap-1.5">
    <span className="text-muted-foreground [&>svg]:size-3.5">{icon}</span>
    <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold">{children}</span>
    {right}
  </div>
);

const Meta = ({ children }: { children: ReactNode }) => <div className="mt-1 truncate text-[11px] text-muted-foreground">{children}</div>;

const SourceNode = memo(({ data, selected }: Props<SourceData>) => (
  <Shell selected={selected} tone="neutral">
    <Title icon={<FileText />}>source · {data.sourceLocale}</Title>
    <Meta>{data.sample.resourceId ? data.sample.key : 'synthetic sample'}</Meta>
    <Meta>{data.processors.length > 0 ? `processors: ${data.processors.join(', ')}` : 'no source processors'}</Meta>
    <Handle type="source" position={Position.Right} />
  </Shell>
));

const LAYER_STATE: Record<LayerData['explain']['state'], string | null> = {
  active: null,
  disabled: 'disabled for this scenario',
  'no-prompts': 'skipped — nothing to say',
  'out-of-scope': 'other scenario',
};

const LayerNode = memo(({ data, selected }: Props<LayerData>) => {
  const { explain } = data;
  const reason = LAYER_STATE[explain.state];
  return (
    <Shell selected={selected} inactive={explain.state !== 'active'} tone="primary">
      <Handle type="target" position={Position.Left} />
      <Title
        icon={<Layers />}
        right={explain.layer.builtin ? <Badge variant="muted">built-in</Badge> : <Badge variant="info">scenario</Badge>}
      >
        {explain.layer.name}
      </Title>
      <Meta>
        {explain.effective.model}
        {explain.effective.reasoningEffort ? ` · ${explain.effective.reasoningEffort}` : ''}
        {explain.overrides.length > 0 ? ' · overridden' : ''}
      </Meta>
      <Meta>{reason ?? `${explain.prompts.filter((prompt) => prompt.state === 'active').length} fragments`}</Meta>
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Bottom} id="prompts" />
    </Shell>
  );
});

const StageNode = memo(({ data, selected }: Props<StageData>) => {
  const { stage } = data;
  return (
    <Shell selected={selected} inactive={!stage.enabled} tone="info">
      <Handle type="target" position={Position.Left} />
      <Title icon={<Code />} right={<Badge variant="muted">code</Badge>}>
        {stage.name}
      </Title>
      <Meta>{stage.enabled ? (stage.description ?? `stage · #${stage.position}`) : 'does not match this sample'}</Meta>
      <Handle type="source" position={Position.Right} />
    </Shell>
  );
});

const PROMPT_STATE: Record<PromptData['prompt']['state'], string | null> = {
  active: null,
  disabled: 'disabled',
  empty: 'renders empty for sample',
  'out-of-scope': 'does not match',
};

const scopeLabel = (prompt: PromptData['prompt']['prompt']): string =>
  prompt.scope === 'default' ? 'default' : prompt.scope === 'scenario' ? 'scenario' : `${prompt.scope}: ${prompt.scopeRef}`;

const PromptNode = memo(({ data, selected }: Props<PromptData>) => {
  const { prompt } = data;
  const reason = PROMPT_STATE[prompt.state];
  return (
    <Shell selected={selected} inactive={prompt.state !== 'active'} tone="neutral">
      <Handle type="source" position={Position.Top} />
      <Title icon={<Sparkles />} right={<Badge variant="muted">v{prompt.prompt.version}</Badge>}>
        {prompt.prompt.name}
      </Title>
      <Meta>
        {scopeLabel(prompt.prompt)} · #{prompt.prompt.position}
        {reason ? ` · ${reason}` : ''}
      </Meta>
    </Shell>
  );
});

const summarizeParams = (params: Record<string, unknown>): string =>
  Object.entries(params)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('|') : String(value)}`)
    .join(' ');

const GuardNode = memo(({ data, selected }: Props<GuardData>) => {
  const { guard } = data;
  return (
    <Shell selected={selected} inactive={!guard.enabled} tone="warning">
      <Handle type="target" position={Position.Left} />
      <Title icon={<ShieldCheck />} right={guard.source === 'rule' ? <Badge variant="info">rule</Badge> : <Badge variant="muted">config</Badge>}>
        {guard.name}
      </Title>
      <Meta>
        {guard.enabled ? (Object.keys(guard.params).length > 0 ? summarizeParams(guard.params) : 'default parameters') : 'switched off'}
        {guard.canRepair ? ' · repairs' : ''}
      </Meta>
      <Handle type="source" position={Position.Right} />
    </Shell>
  );
});

const TargetNode = memo(({ data, selected }: Props<TargetData>) => (
  <Shell selected={selected} tone="neutral">
    <Handle type="target" position={Position.Left} />
    <Title icon={<Target />}>target · {data.locale}</Title>
    <Meta>{data.processors.length > 0 ? `processors: ${data.processors.join(', ')}` : 'no output processors'}</Meta>
  </Shell>
));

export const nodeTypes = { source: SourceNode, layer: LayerNode, stage: StageNode, prompt: PromptNode, guard: GuardNode, target: TargetNode };
