import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Copy, History as HistoryIcon, Pin, PinOff, RefreshCw, Star, TriangleAlert } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Empty, ErrorNote } from '../components/layout';
import { OriginBadge, StatusBadge, VerdictBadge } from '../components/status';
import { Badge } from '../components/ui/badge';
import { Button, type ButtonProps } from '../components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import { cn, formatDate, formatUsd } from '../lib/utils';
import type { ResourceDetail, TargetDetail } from '../../core/resources/service';

const isStale = (resource: ResourceDetail, target: TargetDetail): boolean =>
  target.value !== null && target.sourceRevision !== resource.sourceRevision;

type Filter = { key: string; label: string; match: (target: TargetDetail, resource: ResourceDetail) => boolean };

const FILTERS: Filter[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'translated', label: 'Translated', match: (target) => target.status === 'translated' },
  {
    key: 'attention',
    label: 'Needs attention',
    match: (target, resource) => target.status === 'rejected' || target.status === 'failed' || isStale(resource, target),
  },
  { key: 'progress', label: 'In progress', match: (target) => ['pending', 'queued', 'translating'].includes(target.status) },
];

const IconButton = ({ label, className, children, ...props }: ButtonProps & { label: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button variant="ghost" size="icon" className={cn('size-7', className)} aria-label={label} {...props}>
        {children}
      </Button>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);

const CopyButton = ({ value }: { value: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? 'Copied' : 'Copy key'}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
    </IconButton>
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

const TargetRow = ({ resource, target, readOnly }: { resource: ResourceDetail; target: TargetDetail; readOnly: boolean }) => {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['resource', resource.id] });
  const pin = useMutation({ mutationFn: (pinned: boolean) => api.targets.pin(target.id, pinned), onSuccess: refresh });
  const native = useMutation({ mutationFn: (value: boolean) => api.targets.native(target.id, value), onSuccess: refresh });
  const retranslate = useMutation({ mutationFn: () => api.targets.retranslate(target.id), onSuccess: refresh });
  const save = useMutation({
    mutationFn: (value: string) => api.targets.setValue(target.id, value),
    onSuccess: () => {
      setDraft(null);
      refresh();
    },
  });

  const skipped = target.status === 'skipped';
  const stale = isStale(resource, target);
  const current = target.value ?? '';
  const dirty = draft !== null && draft !== current;
  const cost = target.runs.reduce((sum, run) => sum + (run.costUsd ?? 0) / Math.max(run.targetCount, 1), 0);
  const hasHistory = target.verdicts.length > 0 || target.runs.length > 0;
  const error = pin.error ?? native.error ?? retranslate.error ?? save.error;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && dirty) {
      event.preventDefault();
      save.mutate(draft);
    }
    if (event.key === 'Escape' && draft !== null) {
      event.preventDefault();
      setDraft(null);
    }
  };

  return (
    <article className={cn('group/target px-4 py-3 transition-colors', dirty && 'bg-muted/30')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="w-10 font-mono text-sm font-semibold">{target.locale}</span>
        <StatusBadge status={target.status} />
        <OriginBadge origin={target.origin} />
        {target.pinned ? (
          <Badge variant="warning">
            <Pin className="mr-1 size-3" /> pinned
          </Badge>
        ) : null}
        {target.native ? (
          <Badge variant="info">
            <Star className="mr-1 size-3 fill-current" /> native
          </Badge>
        ) : null}
        {stale ? (
          <Badge variant="destructive">
            <TriangleAlert className="mr-1 size-3" /> stale source
          </Badge>
        ) : null}
        <span className="ml-auto hidden text-xs text-muted-foreground tabular-nums sm:inline">
          {target.runs.length} runs · {formatUsd(cost)} · {formatDate(target.updatedAt)}
        </span>
        <div className="flex items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover/target:opacity-100 md:opacity-0">
          {readOnly ? null : (
            <>
              <IconButton label={target.pinned ? 'Unpin' : 'Pin — the pipeline never overwrites it'} onClick={() => pin.mutate(!target.pinned)} disabled={pin.isPending}>
                {target.pinned ? <PinOff /> : <Pin />}
              </IconButton>
              <IconButton
                label={target.native ? 'Unmark native' : 'Mark native — human-approved, used as an example'}
                onClick={() => native.mutate(!target.native)}
                disabled={native.isPending || !target.value}
              >
                <Star className={target.native ? 'fill-current' : ''} />
              </IconButton>
              <IconButton label="Re-translate" onClick={() => retranslate.mutate()} disabled={retranslate.isPending || skipped}>
                <RefreshCw className={retranslate.isPending ? 'animate-spin' : ''} />
              </IconButton>
            </>
          )}
          <IconButton
            label={showHistory ? 'Hide history' : `History · ${target.verdicts.length} verdicts`}
            onClick={() => setShowHistory((value) => !value)}
            disabled={!hasHistory}
            className={showHistory ? 'bg-accent' : ''}
          >
            <HistoryIcon />
          </IconButton>
        </div>
      </div>

      <textarea
        value={draft ?? current}
        placeholder={skipped ? 'Not applicable for this locale' : 'No translation yet — type to add one'}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        rows={Math.min(8, Math.max(1, current.split('\n').length))}
        disabled={skipped || readOnly}
        readOnly={readOnly}
        className="mt-2 -mx-2 w-[calc(100%+1rem)] resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-sm leading-relaxed field-sizing-content placeholder:text-muted-foreground hover:border-input focus-visible:border-input focus-visible:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      />

      {target.lastError ? (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          {target.lastError}
        </p>
      ) : null}

      {dirty ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => save.mutate(draft)} disabled={save.isPending}>
            Save as human translation
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Discard
          </Button>
          <span className="text-xs text-muted-foreground">⌘↵ to save · Esc to discard</span>
        </div>
      ) : null}

      {error ? (
        <div className="mt-2">
          <ErrorNote error={error} />
        </div>
      ) : null}
      {showHistory ? <History target={target} /> : null}
    </article>
  );
};

const byCreatedAt = <T extends { createdAt: Date | string }>(a: T, b: T): number => String(a.createdAt).localeCompare(String(b.createdAt));

const History = ({ target }: { target: TargetDetail }) => {
  const runIds = [...new Set([...target.runs.map((run) => run.runId), ...target.verdicts.map((verdict) => verdict.runId)])];
  const attempts = runIds
    .map((runId) => ({
      runId,
      runs: target.runs.filter((run) => run.runId === runId).sort(byCreatedAt),
      verdicts: target.verdicts.filter((verdict) => verdict.runId === runId).sort(byCreatedAt),
    }))
    .map((attempt) => ({ ...attempt, startedAt: attempt.runs[0]?.createdAt ?? attempt.verdicts[0]?.createdAt }))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

  return (
    <div className="mt-3 divide-y rounded-lg border bg-muted/30 text-xs">
      {attempts.map((attempt, index) => (
        <section key={attempt.runId} className="grid gap-2 p-3">
          <div className="flex items-center justify-between">
            <span className="font-medium">Attempt {attempts.length - index}</span>
            <span className="text-muted-foreground">{attempt.startedAt ? formatDate(attempt.startedAt) : null}</span>
          </div>
          <ul className="grid gap-1.5">
            {attempt.runs.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge variant={run.kind === 'repair' ? 'warning' : 'secondary'}>{run.layerName}</Badge>
                <span className="font-mono">{run.model}</span>
                <span className="text-muted-foreground tabular-nums">
                  {run.inputTokens.toLocaleString()}→{run.outputTokens.toLocaleString()} tok · {formatUsd(run.costUsd)} · {run.latencyMs}ms · batch of{' '}
                  {run.targetCount}
                </span>
                {run.error ? <span className="text-destructive">{run.error}</span> : null}
              </li>
            ))}
            {attempt.verdicts.map((verdict) => (
              <li key={verdict.id} className="grid gap-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <VerdictBadge outcome={verdict.outcome} />
                  <span className="font-medium">{verdict.guard}</span>
                  {verdict.detail ? <span className="text-muted-foreground">{verdict.detail}</span> : null}
                </div>
                {verdict.before !== null && verdict.after !== null ? (
                  <div className="grid gap-0.5 border-l-2 pl-2 font-mono">
                    <span className="text-destructive/80 line-through decoration-destructive/40">{verdict.before}</span>
                    <span className="text-success">{verdict.after}</span>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
};

const FilterChip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) => (
  <Button size="sm" variant={active ? 'secondary' : 'ghost'} className="h-7 gap-1.5 px-2.5" onClick={onClick}>
    {children}
  </Button>
);

export const ResourcePage = () => {
  const { id = '' } = useParams();
  const resource = useQuery({ queryKey: ['resource', id], queryFn: () => api.resources.get(id), refetchInterval: 4000 });
  const [filterKey, setFilterKey] = useState('all');
  const canEdit = useCan(resource.data?.project.slug, 'editor');
  if (resource.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!resource.data) return <ErrorNote error={resource.error ?? new Error('Resource not found')} />;

  const { data } = resource;
  const counts = FILTERS.map((filter) => ({ ...filter, count: data.targets.filter((target) => filter.match(target, data)).length }));
  const active = counts.find((filter) => filter.key === filterKey && filter.count > 0) ?? counts[0];
  const visible = active ? data.targets.filter((target) => active.match(target, data)) : data.targets;

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
          </div>
          <div className="min-h-0 flex-1 divide-y overflow-auto">
            {data.targets.length === 0 ? (
              <div className="p-4">
                <Empty>No target locales configured for this project.</Empty>
              </div>
            ) : null}
            {visible.map((target) => (
              <TargetRow key={target.id} resource={data} target={target} readOnly={!canEdit} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
