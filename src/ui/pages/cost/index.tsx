import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Empty, ErrorNote, PageHeader } from '../../components/layout';
import { ProjectFilter, useProjectParam } from '../../components/project-filter';
import { Stat } from '../../components/stat';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Select } from '../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { api } from '../../lib/api';
import { formatUsd } from '../../lib/utils';
import type { CostDimension } from '../../../core/ops/service';
import { SpendChart } from './chart';
import { toStackedSeries } from './series';

const DIMENSIONS: { value: CostDimension; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'locale', label: 'Locale' },
  { value: 'layer', label: 'Layer' },
  { value: 'model', label: 'Model' },
  { value: 'day', label: 'Day' },
];

/** Series past this many fold into Other: the chart has five categorical colours. */
const TOP_SERIES = 5;

export const AnalyticsPage = () => {
  const [project, setProject] = useProjectParam();
  const [groupBy, setGroupBy] = useState<CostDimension>('project');
  const stackBy = groupBy === 'day' ? undefined : groupBy;
  const rows = useQuery({ queryKey: ['cost', groupBy, project], queryFn: () => api.cost(groupBy, project), refetchInterval: 10000 });
  const daily = useQuery({ queryKey: ['cost-daily', stackBy, project], queryFn: () => api.costDaily(stackBy, project), refetchInterval: 10000 });
  const series = useMemo(() => toStackedSeries(daily.data ?? [], { topN: TOP_SERIES, nullLabel: stackBy ? '(none)' : 'Spend' }), [daily.data, stackBy]);
  const total = rows.data?.reduce((sum, row) => sum + (row.costUsd ?? 0), 0) ?? 0;
  const label = DIMENSIONS.find((dimension) => dimension.value === groupBy)?.label;

  return (
    <>
      <PageHeader
        title="Cost"
        description="Every model call is a row in layer_runs with tokens and USD from the LiteLLM price file; this is a GROUP BY over the cost_summary view."
        actions={
          <>
            <ProjectFilter value={project} onChange={setProject} />
            <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as CostDimension)}>
              {DIMENSIONS.map((dimension) => (
                <option key={dimension.value} value={dimension.value}>
                  by {dimension.label}
                </option>
              ))}
            </Select>
          </>
        }
      />
      <ErrorNote error={rows.error ?? daily.error} />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label="Total spend" value={formatUsd(total)} />
        <Stat label="Model calls" value={rows.data?.reduce((sum, row) => sum + row.runs, 0) ?? 0} />
        <Stat label="Unpriced calls" value={rows.data?.reduce((sum, row) => sum + row.unpriced, 0) ?? 0} />
      </div>
      {series.data.length > 0 ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Daily spend</CardTitle>
            {stackBy ? <CardDescription>By {label?.toLowerCase()}</CardDescription> : null}
          </CardHeader>
          <CardContent>
            <SpendChart series={series} />
          </CardContent>
        </Card>
      ) : null}
      {rows.data?.length === 0 ? <Empty>No model calls recorded yet.</Empty> : null}
      {rows.data && rows.data.length > 0 ? (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{label}</TableHead>
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
