import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Copy } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { FlowCanvas } from '../../components/flow/canvas';
import { Empty, ErrorNote } from '../../components/layout';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { formatDate } from '../../lib/utils';
import type { ResourceDetail, TargetDetail } from '../../../core/resources/service';
import { isInProgress, isStale, layoutResource, SOURCE_NODE_ID } from './layout';
import { nodeTypes } from './nodes';
import { NodePanel } from './panel';

type Filter = { key: string; label: string; match: (target: TargetDetail, resource: ResourceDetail) => boolean };

const FILTERS: Filter[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'translated', label: 'Translated', match: (target) => target.status === 'translated' },
  {
    key: 'attention',
    label: 'Needs attention',
    match: (target, resource) => target.status === 'rejected' || target.status === 'failed' || isStale(resource, target),
  },
  { key: 'progress', label: 'In progress', match: isInProgress },
];

const CopyButton = ({ value }: { value: string }) => {
  const [copied, setCopied] = useState(false);
  const label = copied ? 'Copied' : 'Copy key';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={label}
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
};

const SourcePanel = ({ resource }: { resource: ResourceDetail }) => {
  const meta = Object.entries(resource.meta).filter(([, value]) => value !== null && value !== undefined && value !== '');
  return (
    <aside className="flex min-h-0 flex-col overflow-auto rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Source</h2>
        <Badge variant="outline" className="font-mono">
          {resource.project.sourceLocale}
        </Badge>
        {!resource.translatable ? <Badge variant="muted">not translatable</Badge> : null}
      </div>
      <div className="grid gap-4 p-4">
        <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{resource.source}</p>
        {resource.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {resource.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
        {meta.length > 0 ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t pt-4 text-xs">
            {meta.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="break-words font-mono">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t pt-4 text-xs">
          <dt className="text-muted-foreground">revision</dt>
          <dd className="font-mono">{resource.sourceRevision.slice(0, 12)}</dd>
          <dt className="text-muted-foreground">updated</dt>
          <dd>{formatDate(resource.updatedAt)}</dd>
        </dl>
      </div>
    </aside>
  );
};

const FilterChip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) => (
  <Button size="sm" variant={active ? 'secondary' : 'ghost'} className="h-7 gap-1.5 px-2.5" onClick={onClick}>
    {children}
  </Button>
);

export const ResourcePage = () => {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const resource = useQuery({ queryKey: ['resource', id], queryFn: () => api.resources.get(id), refetchInterval: 4000 });
  const [filterKey, setFilterKey] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const canEdit = useCan(resource.data?.project.slug, 'editor');
  const { data } = resource;

  const counts = useMemo(() => (data ? FILTERS.map((filter) => ({ ...filter, count: data.targets.filter((target) => filter.match(target, data)).length })) : []), [data]);
  const active = counts.find((filter) => filter.key === filterKey && filter.count > 0) ?? counts[0];
  const graph = useMemo(() => (data && active ? layoutResource(data, data.targets.filter((target) => active.match(target, data))) : null), [data, active]);
  // The selection survives refetches and filter changes: it is re-derived from the full layout by node id.
  const selectedData = useMemo(
    () => (data && selectedId ? (layoutResource(data, data.targets).nodes.find((node) => node.id === selectedId)?.data ?? null) : null),
    [data, selectedId],
  );
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['resource', id] });

  if (resource.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data) return <ErrorNote error={resource.error ?? new Error('Resource not found')} />;

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="min-w-0">
        <Link to={`/projects/${data.project.slug}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> {data.project.name}
        </Link>
        <div className="mt-1 flex items-center gap-1">
          <h1 className="min-w-0 break-all font-mono text-lg font-semibold leading-tight">{data.key}</h1>
          <CopyButton value={data.key} />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:auto-rows-[minmax(0,1fr)] lg:grid-cols-[minmax(280px,1fr)_minmax(0,2.2fr)]">
        <SourcePanel resource={data} />
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
            <h2 className="mr-2 text-sm font-semibold">Translations</h2>
            {counts
              .filter((filter) => filter.key === 'all' || filter.count > 0)
              .map((filter) => (
                <FilterChip key={filter.key} active={filter.key === active?.key} onClick={() => setFilterKey(filter.key)}>
                  {filter.label}
                  <span className="text-muted-foreground tabular-nums">{filter.count}</span>
                </FilterChip>
              ))}
            <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">Latest attempt per locale · click a node for details</span>
          </div>
          <div className="min-h-[360px] flex-1 bg-muted/20">
            {data.targets.length === 0 ? (
              <div className="p-4">
                <Empty>No target locales configured for this project.</Empty>
              </div>
            ) : graph ? (
              <FlowCanvas
                nodes={graph.nodes}
                edges={graph.edges}
                nodeTypes={nodeTypes}
                selectedId={selectedId}
                onSelect={(nodeId) => setSelectedId(nodeId === SOURCE_NODE_ID ? null : nodeId)}
                focusId={SOURCE_NODE_ID}
              />
            ) : null}
          </div>
        </section>
      </div>
      <NodePanel data={selectedData} ctx={{ readOnly: !canEdit, refresh }} onClose={() => setSelectedId(null)} />
    </div>
  );
};
