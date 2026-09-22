import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Empty, ErrorNote, PageHeader } from '../../components/layout';
import { OriginBadge, StatusBadge } from '../../components/status';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { truncate } from '../../lib/utils';
import type { ResourceListItem } from '../../../core/resources/service';
import { type TargetStatus, targetStatus } from '../../../db/schema';
import { TranslateDialog } from './translate-dialog';

const PAGE_SIZE = 50;

type TargetSummaryProps = { targets: ResourceListItem['targets']; onStatus: (status: TargetStatus) => void };

/** Forty locales do not fit in a row: one chip per status with its locales in the tooltip, plus flag and legacy counts. */
const TargetSummary = ({ targets, onStatus }: TargetSummaryProps) => {
  const byStatus = targetStatus.enumValues
    .map((status) => [status, targets.filter((target) => target.status === status)] as const)
    .filter(([, group]) => group.length > 0);
  const pinned = targets.filter((target) => target.pinned).length;
  const native = targets.filter((target) => target.native).length;
  const legacy = targets.filter((target) => target.origin === 'legacy').length;
  const human = targets.filter((target) => target.origin === 'human').length;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {byStatus.map(([status, group]) => (
        <button
          key={status}
          type="button"
          className="inline-flex items-center gap-1 rounded-md hover:bg-muted"
          title={group.map((target) => target.locale).join(', ')}
          onClick={(event) => {
            event.stopPropagation();
            onStatus(status);
          }}
        >
          <StatusBadge status={status} />
          <span className="tabular-nums text-muted-foreground">{group.length}</span>
        </button>
      ))}
      {pinned > 0 ? <span title="pinned">📌 {pinned}</span> : null}
      {native > 0 ? <span title="native">★ {native}</span> : null}
      {legacy > 0 ? (
        <span className="inline-flex items-center gap-1">
          <OriginBadge origin="legacy" />
          <span className="tabular-nums text-muted-foreground">{legacy}</span>
        </span>
      ) : null}
      {human > 0 ? (
        <span className="inline-flex items-center gap-1">
          <OriginBadge origin="human" />
          <span className="tabular-nums text-muted-foreground">{human}</span>
        </span>
      ) : null}
    </div>
  );
};

export const ProjectPage = () => {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const filter = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    locale: params.get('locale') ?? '',
    tag: params.get('tag') ?? '',
    page: Number(params.get('page') ?? '1'),
  };
  const setFilter = (patch: Partial<typeof filter>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries({ ...patch, page: patch.page ?? 1 })) {
      if (value === '' || value === undefined || (key === 'page' && value === 1)) next.delete(key);
      else next.set(key, String(value));
    }
    setParams(next);
  };

  const project = useQuery({ queryKey: ['project', slug], queryFn: () => api.projects.get(slug), refetchInterval: 5000 });
  const resources = useQuery({
    queryKey: ['resources', slug, filter],
    queryFn: () => api.projects.resources(slug, { ...filter, limit: PAGE_SIZE }),
    refetchInterval: 5000,
  });
  const [queued, setQueued] = useState<number | null>(null);
  const onQueued = (enqueued: number) => {
    setQueued(enqueued);
    void queryClient.invalidateQueries({ queryKey: ['project', slug] });
    void queryClient.invalidateQueries({ queryKey: ['resources', slug] });
  };
  const canEdit = useCan(slug, 'editor');
  const canAdmin = useCan(slug, 'admin');

  if (!project.data) return <ErrorNote error={project.error} />;
  const locales = project.data.targetLocales;
  const total = resources.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader
        title={project.data.name}
        description={`${project.data.sourceLocale} → ${locales.join(', ')}`}
        actions={
          <>
            {canEdit ? <TranslateDialog slug={slug} counts={project.data.counts} onQueued={onQueued} /> : null}
            <Button variant="outline" asChild>
              <Link to={`/projects/${slug}/layers`}>
                <Layers /> Layers
              </Link>
            </Button>
            {canAdmin ? (
              <Button variant="outline" asChild>
                <Link to={`/projects/${slug}/settings`}>
                  <Settings2 /> Settings
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      {queued !== null ? (
        <div className="mb-4 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          Queued {queued} targets.{' '}
          <Link to="/queue" className="text-primary underline underline-offset-2">
            Open the queue
          </Link>
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input className="w-64" placeholder="Search key or source" value={filter.q} onChange={(e) => setFilter({ q: e.target.value })} />
        <Select value={filter.status} onChange={(e) => setFilter({ status: e.target.value })}>
          <option value="">Any status</option>
          {targetStatus.enumValues.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </Select>
        <Select value={filter.locale} onChange={(e) => setFilter({ locale: e.target.value })}>
          <option value="">Any locale</option>
          {locales.map((locale) => (
            <option key={locale} value={locale}>
              {locale}
            </option>
          ))}
        </Select>
        <Input className="w-40" placeholder="Tag" value={filter.tag} onChange={(e) => setFilter({ tag: e.target.value })} />
        <span className="ml-auto text-sm text-muted-foreground">{total} resources</span>
      </div>

      {resources.data?.items.length === 0 ? <Empty>Nothing matches. Resources arrive when your repo's adapter imports them with a project API key.</Empty> : null}
      {resources.data && resources.data.items.length > 0 ? (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[30%]">Key</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="w-[26%]">Targets</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resources.data.items.map((resource) => (
                <TableRow
                  key={resource.id}
                  className="cursor-pointer"
                  onClick={(event) => {
                    // Links and buttons inside the row keep their own behaviour.
                    if ((event.target as HTMLElement).closest('a, button')) return;
                    void navigate(`/resources/${resource.id}`);
                  }}
                >
                  <TableCell className="align-top">
                    <Link to={`/resources/${resource.id}`} className="font-mono text-xs text-primary hover:underline">
                      {truncate(resource.key, 70)}
                    </Link>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {resource.tags.map((tag) => (
                        <Badge
                          key={tag}
                          variant="outline"
                          className="cursor-pointer"
                          onClick={(event) => {
                            event.stopPropagation();
                            setFilter({ tag });
                          }}
                        >
                          {tag}
                        </Badge>
                      ))}
                      {!resource.translatable ? <Badge variant="muted">not translatable</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-pre-wrap align-top text-sm">{truncate(resource.source, 160)}</TableCell>
                  <TableCell className="align-top">
                    <TargetSummary targets={resource.targets} onStatus={(status) => setFilter({ status })} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {pages > 1 ? (
        <div className="mt-4 flex items-center justify-end gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={filter.page <= 1} onClick={() => setFilter({ page: filter.page - 1 })}>
            Previous
          </Button>
          <span className="text-muted-foreground">
            {filter.page} / {pages}
          </span>
          <Button variant="outline" size="sm" disabled={filter.page >= pages} onClick={() => setFilter({ page: filter.page + 1 })}>
            Next
          </Button>
        </div>
      ) : null}
    </>
  );
};
