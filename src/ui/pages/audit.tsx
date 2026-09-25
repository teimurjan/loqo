import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Empty, ErrorNote, PageHeader } from '../components/layout';
import { Badge } from '../components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { api } from '../lib/api';
import { formatDate, truncate } from '../lib/utils';

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
