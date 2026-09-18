import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { Empty, ErrorNote, PageHeader } from '../components/layout';
import { type Column, VirtualTable } from '../components/virtual-table';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Select } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { api } from '../lib/api';
import { cn, formatDate, formatUsd, truncate } from '../lib/utils';
import type { CostDimension, QueueStatus, SuspiciousTarget } from '../../core/ops/service';

const Stat = ({ label, value }: { label: string; value: number | string }) => (
  <Card>
    <CardHeader className="pb-1">
      <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</CardTitle>
    </CardHeader>
    <CardContent className="text-2xl font-semibold tabular-nums">{value}</CardContent>
  </Card>
);

type Failure = QueueStatus['recentFailures'][number];

const FAILURE_COLUMNS: Column<Failure>[] = [
  { key: 'project', header: 'Project', cell: (row) => row.projectSlug },
  { key: 'key', header: 'Key', className: 'font-mono text-xs', cell: (row) => truncate(row.key, 60) },
  { key: 'locale', header: 'Locale', cell: (row) => row.locale },
  { key: 'reason', header: 'Reason', className: 'text-destructive', cell: (row) => row.lastError },
  { key: 'when', header: 'When', className: 'whitespace-nowrap text-muted-foreground', cell: (row) => formatDate(row.updatedAt) },
];

const SUSPICIOUS_COLUMNS: Column<SuspiciousTarget>[] = [
  { key: 'project', header: 'Project', cell: (row) => row.projectSlug },
  {
    key: 'key',
    header: 'Key',
    cell: (row) => (
      <Link to={`/resources/${row.resourceId}`} className="font-mono text-xs text-primary hover:underline">
        {truncate(row.key, 60)}
      </Link>
    ),
  },
  { key: 'locale', header: 'Locale', cell: (row) => row.locale },
  { key: 'value', header: 'Value', cell: (row) => truncate(row.value ?? '', 80) },
];

const Section = ({ title, description, grow, children }: { title: string; description?: string; grow: boolean; children: ReactNode }) => (
  <section className={cn('flex min-h-0 flex-col pt-8', grow && 'flex-1')}>
    <h2 className={cn('text-lg font-semibold', description ? 'mb-1' : 'mb-3')}>{title}</h2>
    {description ? <p className="mb-3 text-sm text-muted-foreground">{description}</p> : null}
    {children}
  </section>
);

export const QueuePage = () => {
  const status = useQuery({ queryKey: ['queue'], queryFn: () => api.queue(), refetchInterval: 3000 });
  const suspicious = useQuery({ queryKey: ['suspicious'], queryFn: () => api.suspicious(), refetchInterval: 15000 });
  const queue = status.data?.queue;
  const targets = status.data?.targets ?? {};
  const failures = status.data?.recentFailures;

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Queue" description="The translate queue and the targets it feeds." />
      <ErrorNote error={status.error} />
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Ready" value={queue?.ready ?? 0} />
        <Stat label="Deferred" value={queue?.deferred ?? 0} />
        <Stat label="Active" value={queue?.active ?? 0} />
        <Stat label="Failed jobs" value={queue?.failed ?? 0} />
        <Stat label="Pending targets" value={targets.pending ?? 0} />
        <Stat label="Rejected targets" value={targets.rejected ?? 0} />
      </div>

      <Section title="Recent rejections & failures" grow={(failures?.length ?? 0) > 0}>
        {failures?.length === 0 ? <Empty>Nothing rejected or failed.</Empty> : null}
        {failures && failures.length > 0 ? <VirtualTable rows={failures} columns={FAILURE_COLUMNS} rowKey={(row) => row.id} /> : null}
      </Section>

      <Section title="Suspicious translations" description="Translated values identical to their source." grow={(suspicious.data?.length ?? 0) > 0}>
        {suspicious.data?.length === 0 ? <Empty>None.</Empty> : null}
        {suspicious.data && suspicious.data.length > 0 ? (
          <VirtualTable rows={suspicious.data} columns={SUSPICIOUS_COLUMNS} rowKey={(row) => row.id} />
        ) : null}
      </Section>
    </div>
  );
};

const DIMENSIONS: { value: CostDimension; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'locale', label: 'Locale' },
  { value: 'layer', label: 'Layer' },
  { value: 'model', label: 'Model' },
  { value: 'day', label: 'Day' },
];

export const AnalyticsPage = () => {
  const [groupBy, setGroupBy] = useState<CostDimension>('project');
  const rows = useQuery({ queryKey: ['cost', groupBy], queryFn: () => api.cost(groupBy), refetchInterval: 10000 });
  const total = rows.data?.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) ?? 0;

  return (
    <>
      <PageHeader
        title="Cost"
        description="Every model call is a row in layer_runs with tokens and USD from the LiteLLM price file; this is a GROUP BY over the cost_summary view."
        actions={
          <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as CostDimension)}>
            {DIMENSIONS.map((dimension) => (
              <option key={dimension.value} value={dimension.value}>
                by {dimension.label}
              </option>
            ))}
          </Select>
        }
      />
      <ErrorNote error={rows.error} />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label="Total spend" value={formatUsd(total)} />
        <Stat label="Model calls" value={rows.data?.reduce((sum, row) => sum + row.runs, 0) ?? 0} />
        <Stat label="Unpriced calls" value={rows.data?.reduce((sum, row) => sum + row.unpriced, 0) ?? 0} />
      </div>
      {rows.data?.length === 0 ? <Empty>No model calls recorded yet.</Empty> : null}
      {rows.data && rows.data.length > 0 ? (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{DIMENSIONS.find((d) => d.value === groupBy)?.label}</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Targets</TableHead>
                <TableHead className="text-right">Input tok</TableHead>
                <TableHead className="text-right">Output tok</TableHead>
                <TableHead className="text-right">USD</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.data.map((row) => (
                <TableRow key={row.group ?? 'none'}>
                  <TableCell className="font-medium">{row.group ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.runs}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.targets}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.inputTokens.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.outputTokens.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUsd(row.costUsd)}
                    {row.unpriced > 0 ? <Badge variant="warning" className="ml-2">{row.unpriced} unpriced</Badge> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </>
  );
};

export const AuditPage = () => {
  const entries = useQuery({ queryKey: ['audit'], queryFn: () => api.audit(200), refetchInterval: 10000 });
  return (
    <>
      <PageHeader title="Audit Log" description="Who pinned, edited, re-translated or reconfigured what." />
      <ErrorNote error={entries.error} />
      {entries.data?.length === 0 ? <Empty>Nothing yet.</Empty> : null}
      {entries.data && entries.data.length > 0 ? (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.data.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(entry.createdAt)}</TableCell>
                  <TableCell>{entry.actor}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{entry.action}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {entry.resourceId ? (
                      <Link to={`/resources/${entry.resourceId}`} className="mr-2 text-primary hover:underline">
                        resource
                      </Link>
                    ) : null}
                    {truncate(JSON.stringify(entry.detail), 140)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </>
  );
};
