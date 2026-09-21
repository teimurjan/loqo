import { useMutation } from '@tanstack/react-query';
import { Pin, PinOff, RefreshCw, Star, TriangleAlert } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { NodeSheet, Row, Section } from '../../components/flow/panel';
import { ErrorNote } from '../../components/layout';
import { OriginBadge, StatusBadge, VerdictBadge } from '../../components/status';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/input';
import { SheetDescription, SheetTitle } from '../../components/ui/sheet';
import { api } from '../../lib/api';
import { formatDate, formatUsd } from '../../lib/utils';
import type { LayerRun, Verdict } from '../../../db/schema';
import { type Attempt, attemptsOf, isStale, type ResourceNodeData, type RunData, type TargetData, type VerdictsData } from './layout';

export type PanelContext = { readOnly: boolean; refresh: () => void };

const RunLine = ({ run }: { run: LayerRun }) => (
  <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
    <Badge variant={run.kind === 'repair' ? 'warning' : 'secondary'}>{run.layerName}</Badge>
    <span className="font-mono">{run.model}</span>
    <span className="text-muted-foreground tabular-nums">
      {run.inputTokens.toLocaleString()}→{run.outputTokens.toLocaleString()} tok · {formatUsd(run.costUsd)} · {run.latencyMs}ms · batch of {run.targetCount}
    </span>
    {run.error ? <span className="text-destructive">{run.error}</span> : null}
  </li>
);

const VerdictLine = ({ verdict }: { verdict: Verdict }) => (
  <li className="grid gap-1">
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
);

const History = ({ attempts }: { attempts: Attempt[] }) => (
  <div className="divide-y rounded-lg border bg-muted/30 text-xs">
    {attempts.map((attempt, index) => (
      <section key={attempt.runId} className="grid gap-2 p-3">
        <div className="flex items-center justify-between">
          <span className="font-medium">Attempt {attempts.length - index}</span>
          <span className="text-muted-foreground">{attempt.startedAt ? formatDate(attempt.startedAt) : null}</span>
        </div>
        <ul className="grid gap-1.5">
          {attempt.runs.map((run) => (
            <RunLine key={run.id} run={run} />
          ))}
          {attempt.verdicts.map((verdict) => (
            <VerdictLine key={verdict.id} verdict={verdict} />
          ))}
        </ul>
      </section>
    ))}
  </div>
);

// ---------------------------------------------------------------------------------------------

const TargetPanel = ({ data, ctx }: { data: TargetData; ctx: PanelContext }) => {
  const { resource, target } = data;
  const [draft, setDraft] = useState<string | null>(null);
  const pin = useMutation({ mutationFn: (pinned: boolean) => api.targets.pin(target.id, pinned), onSuccess: ctx.refresh });
  const native = useMutation({ mutationFn: (value: boolean) => api.targets.native(target.id, value), onSuccess: ctx.refresh });
  const retranslate = useMutation({ mutationFn: () => api.targets.retranslate(target.id), onSuccess: ctx.refresh });
  const save = useMutation({
    mutationFn: (value: string) => api.targets.setValue(target.id, value),
    onSuccess: () => {
      setDraft(null);
      ctx.refresh();
    },
  });

  const skipped = target.status === 'skipped';
  const current = target.value ?? '';
  const dirty = draft !== null && draft !== current;
  const attempts = attemptsOf(target);
  const cost = target.runs.reduce((sum, run) => sum + (run.costUsd ?? 0) / Math.max(run.targetCount, 1), 0);
  const error = pin.error ?? native.error ?? retranslate.error ?? save.error;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && dirty) {
      event.preventDefault();
      save.mutate(draft);
    }
    if (event.key === 'Escape' && draft !== null) {
      event.preventDefault();
      event.stopPropagation();
      setDraft(null);
    }
  };

  return (
    <>
      <SheetTitle className="font-mono">{target.locale}</SheetTitle>
      <SheetDescription>
        {resource.project.sourceLocale} → {target.locale} · {target.runs.length} runs · {formatUsd(cost)} · updated {formatDate(target.updatedAt)}
      </SheetDescription>
      <div className="flex flex-wrap items-center gap-1.5">
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
        {isStale(resource, target) ? (
          <Badge variant="destructive">
            <TriangleAlert className="mr-1 size-3" /> stale source
          </Badge>
        ) : null}
      </div>
      <Section title="Translation">
        <Textarea
          value={draft ?? current}
          placeholder={skipped ? 'Not applicable for this locale' : 'No translation yet — type to add one'}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={Math.min(12, Math.max(3, current.split('\n').length + 1))}
          disabled={skipped || ctx.readOnly}
          readOnly={ctx.readOnly}
          className="leading-relaxed"
        />
        {target.lastError ? (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3 shrink-0" />
            {target.lastError}
          </p>
        ) : null}
        {dirty ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => save.mutate(draft)} disabled={save.isPending}>
              Save as human translation
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Discard
            </Button>
            <span className="text-xs text-muted-foreground">⌘↵ to save · Esc to discard</span>
          </div>
        ) : null}
      </Section>
      {ctx.readOnly ? null : (
        <Section title="Actions">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => pin.mutate(!target.pinned)} disabled={pin.isPending}>
              {target.pinned ? <PinOff /> : <Pin />} {target.pinned ? 'Unpin' : 'Pin'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => native.mutate(!target.native)} disabled={native.isPending || !target.value}>
              <Star className={target.native ? 'fill-current' : ''} /> {target.native ? 'Unmark native' : 'Mark native'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => retranslate.mutate()} disabled={retranslate.isPending || skipped}>
              <RefreshCw className={retranslate.isPending ? 'animate-spin' : ''} /> Re-translate
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">The pipeline never overwrites a pinned value. A native value is human-approved and serves as an example for its locale.</p>
        </Section>
      )}
      <ErrorNote error={error} />
      {attempts.length > 0 ? (
        <Section title={`History · ${attempts.length} ${attempts.length === 1 ? 'attempt' : 'attempts'}`}>
          <History attempts={attempts} />
        </Section>
      ) : null}
    </>
  );
};

// ---------------------------------------------------------------------------------------------

const RunPanel = ({ data }: { data: RunData }) => {
  const { run, target } = data;
  const cached = run.cachedInputTokens > 0 ? ` (${run.cachedInputTokens.toLocaleString()} cached)` : '';
  const reasoning = run.reasoningTokens > 0 ? ` (${run.reasoningTokens.toLocaleString()} reasoning)` : '';
  return (
    <>
      <SheetTitle className="font-mono">{run.layerName}</SheetTitle>
      <SheetDescription>
        {run.kind === 'repair' ? 'Repair call a guard asked for' : 'Pipeline layer'} · {target.locale} · {formatDate(run.createdAt)}
      </SheetDescription>
      <Section title="Call">
        <Row label="model">{run.model}</Row>
        <Row label="input tokens">
          {run.inputTokens.toLocaleString()}
          {cached}
        </Row>
        <Row label="output tokens">
          {run.outputTokens.toLocaleString()}
          {reasoning}
        </Row>
        <Row label="cost">{formatUsd(run.costUsd)}</Row>
        <Row label="latency">{run.latencyMs}ms</Row>
        <Row label="batch">{run.targetCount === 1 ? 'this target only' : `${run.targetCount} targets`}</Row>
        <Row label="prompt versions">{run.promptVersionIds.length}</Row>
      </Section>
      {run.error ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          {run.error}
        </p>
      ) : null}
    </>
  );
};

const VerdictsPanel = ({ data }: { data: VerdictsData }) => (
  <>
    <SheetTitle>Guards</SheetTitle>
    <SheetDescription>
      {data.verdicts.length} {data.verdicts.length === 1 ? 'verdict' : 'verdicts'} for {data.target.locale}
      {data.verdicts[0] ? ` · ${formatDate(data.verdicts[0].createdAt)}` : ''}
    </SheetDescription>
    <ul className="grid gap-2 text-xs">
      {data.verdicts.map((verdict) => (
        <VerdictLine key={verdict.id} verdict={verdict} />
      ))}
    </ul>
  </>
);

export const NodePanel = ({ data, ctx, onClose }: { data: ResourceNodeData | null; ctx: PanelContext; onClose: () => void }) => (
  <NodeSheet open={data !== null} onClose={onClose}>
    {data?.kind === 'target' ? <TargetPanel key={data.target.id} data={data} ctx={ctx} /> : null}
    {data?.kind === 'run' ? <RunPanel key={data.run.id} data={data} /> : null}
    {data?.kind === 'verdicts' ? <VerdictsPanel key={data.target.id} data={data} /> : null}
  </NodeSheet>
);
