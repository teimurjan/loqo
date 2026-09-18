import type { TargetStatus } from '../../db/schema';
import { Badge, type BadgeProps } from './ui/badge';

const STATUS_VARIANT: Record<TargetStatus, NonNullable<BadgeProps['variant']>> = {
  pending: 'muted',
  queued: 'info',
  translating: 'info',
  translated: 'success',
  rejected: 'destructive',
  failed: 'destructive',
  skipped: 'outline',
};

export const StatusBadge = ({ status }: { status: TargetStatus }) => <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>;

const ORIGIN_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = { machine: 'secondary', human: 'info', legacy: 'warning' };

export const OriginBadge = ({ origin }: { origin: string | null }) =>
  origin ? <Badge variant={ORIGIN_VARIANT[origin] ?? 'secondary'}>{origin}</Badge> : null;

export const VerdictBadge = ({ outcome }: { outcome: 'pass' | 'repair' | 'reject' }) => (
  <Badge variant={outcome === 'pass' ? 'success' : outcome === 'repair' ? 'warning' : 'destructive'}>{outcome}</Badge>
);
