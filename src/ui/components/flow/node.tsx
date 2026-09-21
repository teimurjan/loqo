import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export type NodeTone = 'neutral' | 'primary' | 'info' | 'warning' | 'destructive';

export const Shell = ({ selected, inactive, tone, children }: { selected: boolean; inactive?: boolean; tone: NodeTone; children: ReactNode }) => (
  <div
    className={cn(
      'w-[260px] rounded-lg border bg-card px-3 py-2 text-left text-card-foreground shadow-xs transition-colors',
      tone === 'primary' && 'border-primary/40',
      tone === 'info' && 'border-info/40',
      tone === 'warning' && 'border-warning/50',
      tone === 'destructive' && 'border-destructive/50',
      selected && 'ring-2 ring-ring',
      inactive && 'opacity-45 border-dashed',
    )}
  >
    {children}
  </div>
);

export const Title = ({ icon, children, right }: { icon: ReactNode; children: ReactNode; right?: ReactNode }) => (
  <div className="flex items-center gap-1.5">
    <span className="text-muted-foreground [&>svg]:size-3.5">{icon}</span>
    <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold">{children}</span>
    {right}
  </div>
);

export const Meta = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cn('mt-1 truncate text-[11px] text-muted-foreground', className)}>{children}</div>
);

/** A couple of lines of body text, for nodes that carry a value rather than a label. */
export const Excerpt = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cn('mt-1 line-clamp-2 break-words text-[11px] leading-snug', className)}>{children}</div>
);
