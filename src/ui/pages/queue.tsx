import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Empty, ErrorNote, PageHeader } from '../components/layout';
import { ProjectFilter, useProjectParam } from '../components/project-filter';
import { Stat } from '../components/stat';
import { StatusBadge } from '../components/status';
import { type Column, VirtualTable } from '../components/virtual-table';
import { api } from '../lib/api';
import { cn, formatDate, truncate } from '../lib/utils';
import { type QueueItem, type QueueStatus, SUSPICIOUS_LIMIT, type SuspiciousTarget } from '../../core/ops/service';

type Failure = QueueStatus['recentFailures'][number];

const keyCell = (row: { resourceId: string; key: string }) => (
  <Link to={`/resources/${row.resourceId}`} className="font-mono text-xs text-primary hover:underline">
    {truncate(row.key, 60)}
  </Link>
);

const projectColumn = { key: 'project', header: 'Project', cell: (row: { projectSlug: string }) => row.projectSlug };
const localeColumn = { key: 'locale', header: 'Locale', cell: (row: { locale: string }) => row.locale };

const QUEUE_COLUMNS: Column<QueueItem>[] = [
  { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
  projectColumn,
  { key: 'key', header: 'Key', cell: keyCell },
  localeColumn,
  { key: 'source', header: 'Source', className: 'text-muted-foreground', cell: (row) => truncate(row.source, 80) },
  { key: 'since', header: 'Since', className: 'whitespace-nowrap text-muted-foreground', cell: (row) => formatDate(row.updatedAt) },
];

const FAILURE_COLUMNS: Column<Failure>[] = [
  { key: 'status', header: 'Status', cell: (row) => <StatusBadge status={row.status} /> },
  projectColumn,
  { key: 'key', header: 'Key', cell: keyCell },
  localeColumn,
  {
    key: 'reason',
    header: 'Reason',
    className: 'text-destructive',
    cell: (row) => <span title={row.lastError ?? undefined}>{truncate(row.lastError ?? '', 120)}</span>,
  },
  { key: 'when', header: 'When', className: 'whitespace-nowrap text-muted-foreground', cell: (row) => formatDate(row.updatedAt) },
];

const SUSPICIOUS_COLUMNS: Column<SuspiciousTarget>[] = [
  projectColumn,
  { key: 'key', header: 'Key', cell: keyCell },
  localeColumn,
  { key: 'value', header: 'Value', cell: (row) => truncate(row.value ?? '', 80) },
];

const Section = ({ title, description, grow, children }: { title: string; description?: string; grow: boolean; children: ReactNode }) => (
  <section className={cn('flex min-h-0 flex-col', grow && 'min-h-72 flex-1')}>
    <h2 className={cn('text-lg font-semibold', description ? 'mb-1' : 'mb-3')}>{title}</h2>
    {description ? <p className="mb-3 text-sm text-muted-foreground">{description}</p> : null}
    {children}
  </section>
);

const Rows = <Row extends { id: string }>({ rows, columns, empty }: { rows: Row[] | undefined; columns: Column<Row>[]; empty: string }) => {
  if (!rows) return null;
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return <VirtualTable rows={rows} columns={columns} rowKey={(row) => row.id} />;
};

export const QueuePage = () => {
  const [project, setProject] = useProjectParam();
  const status = useQuery({ queryKey: ['queue', project], queryFn: () => api.queue(project), refetchInterval: 3000 });
  const suspicious = useQuery({ queryKey: ['suspicious', project], queryFn: () => api.suspicious(project), refetchInterval: 15000 });
  const jobs = status.data?.queue;
  const counts = status.data?.targets ?? {};
  const items = status.data?.items;
  const failures = status.data?.recentFailures;
  const waiting = (counts.queued ?? 0) + (counts.translating ?? 0);
  const suspiciousCount = suspicious.data?.length ?? 0;
  // One project already names every row.
  const visible = <Row,>(columns: Column<Row>[]) => (project ? columns.filter((column) => column.key !== 'project') : columns);

  return (
    <div className="flex h-full flex-col gap-8">
      <div>
        <PageHeader title="Queue" description="The translate queue and the targets it feeds." actions={<ProjectFilter value={project} onChange={setProject} />} />
        <ErrorNote error={status.error ?? suspicious.error} />
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Queued" value={counts.queued ?? 0} />
          <Stat label="Translating" value={counts.translating ?? 0} />
          <Stat label="Pending" value={counts.pending ?? 0} />
          <Stat label="Rejected" value={counts.rejected ?? 0} />
          <Stat label="Failed" value={counts.failed ?? 0} />
          <Stat label="Suspicious" value={suspiciousCount >= SUSPICIOUS_LIMIT ? `${SUSPICIOUS_LIMIT}+` : suspiciousCount} />
        </div>
        {jobs ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Jobs, all projects: {jobs.ready} ready · {jobs.deferred} deferred · {jobs.active} active · {jobs.failed} failed
          </p>
        ) : null}
      </div>

      <Section
        title="Queue"
        description={items && items.length < waiting ? `${waiting} waiting or translating, showing the first ${items.length}.` : `${waiting} waiting or translating.`}
        grow={(items?.length ?? 0) > 0}
      >
        <Rows rows={items} columns={visible(QUEUE_COLUMNS)} empty="Queue is empty." />
      </Section>

      <div className={cn('grid min-h-0 gap-6 lg:grid-cols-2', ((failures?.length ?? 0) > 0 || suspiciousCount > 0) && 'flex-1')}>
        <Section title="Rejections & failures" description="Targets a guard rejected or a model call failed." grow={(failures?.length ?? 0) > 0}>
          <Rows rows={failures} columns={visible(FAILURE_COLUMNS)} empty="Nothing rejected or failed." />
        </Section>
        <Section title="Suspicious translations" description="Translated values identical to their source." grow={suspiciousCount > 0}>
          <Rows rows={suspicious.data} columns={visible(SUSPICIOUS_COLUMNS)} empty="None." />
        </Section>
      </div>
    </div>
  );
};
