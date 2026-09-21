import { Handle, type NodeProps, Position, useReactFlow } from '@xyflow/react';
import { FileText, Layers, ShieldCheck, Target, Wrench } from 'lucide-react';
import { memo } from 'react';
import { focusOn } from '../../components/flow/canvas';
import { Excerpt, Meta, Shell, Title } from '../../components/flow/node';
import { StatusBadge } from '../../components/status';
import { Badge } from '../../components/ui/badge';
import { Select } from '../../components/ui/input';
import { formatUsd, localeFlag } from '../../lib/utils';
import type { Verdict, VerdictOutcome } from '../../../db/schema';
import { isStale, type ResourceNode, type RunData, type SourceData, type TargetData, targetNodeId, type VerdictsData } from './layout';

type Props<Data> = NodeProps<Extract<ResourceNode, { data: Data }>>;

const SourceNode = memo(({ data, selected }: Props<SourceData>) => {
  const { fitView } = useReactFlow();
  return (
    <Shell selected={selected} tone="neutral">
      <Title icon={<FileText />}>source · {data.resource.project.sourceLocale}</Title>
      <Excerpt>{data.resource.source}</Excerpt>
      <Select
        aria-label="Go to locale"
        className="mt-2 h-7 w-full px-2 text-xs"
        value=""
        onChange={(event) => void fitView({ ...focusOn(targetNodeId(event.target.value)), duration: 300 })}
      >
        <option value="" disabled>
          go to locale…
        </option>
        {data.targets.map((target) => (
          <option key={target.id} value={target.id}>
            {[localeFlag(target.locale), target.locale].filter(Boolean).join(' ')}
          </option>
        ))}
      </Select>
      <Handle type="source" position={Position.Right} />
    </Shell>
  );
});

const RunNode = memo(({ data, selected }: Props<RunData>) => {
  const { run } = data;
  const repair = run.kind === 'repair';
  return (
    <Shell selected={selected} tone={run.error ? 'destructive' : repair ? 'warning' : 'primary'}>
      <Handle type="target" position={Position.Left} />
      <Title icon={repair ? <Wrench /> : <Layers />} right={repair ? <Badge variant="warning">repair</Badge> : null}>
        {run.layerName}
      </Title>
      <Meta>{run.model}</Meta>
      {run.error ? (
        <Meta className="text-destructive">{run.error}</Meta>
      ) : (
        <Meta>
          {run.inputTokens.toLocaleString()}→{run.outputTokens.toLocaleString()} tok · {formatUsd(run.costUsd)} · {run.latencyMs}ms
        </Meta>
      )}
      <Handle type="source" position={Position.Right} />
    </Shell>
  );
});

const countOf = (verdicts: Verdict[], outcome: VerdictOutcome): number => verdicts.filter((verdict) => verdict.outcome === outcome).length;

const VerdictsNode = memo(({ data, selected }: Props<VerdictsData>) => {
  const { verdicts } = data;
  const rejects = countOf(verdicts, 'reject');
  const repairs = countOf(verdicts, 'repair');
  const passes = countOf(verdicts, 'pass');
  const summary = [passes > 0 && `${passes} pass`, repairs > 0 && `${repairs} repair`, rejects > 0 && `${rejects} reject`].filter(Boolean).join(' · ');
  const notable = verdicts.find((verdict) => verdict.outcome === 'reject') ?? verdicts.find((verdict) => verdict.outcome === 'repair');
  return (
    <Shell selected={selected} tone={rejects > 0 ? 'destructive' : repairs > 0 ? 'warning' : 'neutral'}>
      <Handle type="target" position={Position.Left} />
      <Title icon={<ShieldCheck />} right={<Badge variant="muted">{verdicts.length}</Badge>}>
        guards
      </Title>
      <Meta>{summary}</Meta>
      <Meta>{notable ? `${notable.guard}${notable.detail ? `: ${notable.detail}` : ''}` : 'all clear'}</Meta>
      <Handle type="source" position={Position.Right} />
    </Shell>
  );
});

const TargetNode = memo(({ data, selected }: Props<TargetData>) => {
  const { resource, target } = data;
  const skipped = target.status === 'skipped';
  const marks = [target.origin, target.pinned && 'pinned', target.native && 'native', isStale(resource, target) && 'stale source'].filter(Boolean).join(' · ');
  const flag = localeFlag(target.locale);
  return (
    <Shell selected={selected} inactive={skipped} tone={target.status === 'rejected' || target.status === 'failed' ? 'destructive' : 'neutral'}>
      <Handle type="target" position={Position.Left} />
      <Title icon={flag ? <span className="text-sm leading-none">{flag}</span> : <Target />} right={<StatusBadge status={target.status} />}>
        {target.locale}
      </Title>
      <Excerpt className={target.value ? undefined : 'italic text-muted-foreground'}>{target.value ?? (skipped ? 'not applicable for this locale' : 'no translation yet')}</Excerpt>
      {marks ? <Meta>{marks}</Meta> : null}
    </Shell>
  );
});

export const nodeTypes = { source: SourceNode, run: RunNode, verdicts: VerdictsNode, target: TargetNode };
