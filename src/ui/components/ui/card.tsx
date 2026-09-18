import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export const Card = ({ className, ...props }: ComponentProps<'div'>) => (
  <div className={cn('rounded-xl border bg-card text-card-foreground shadow-xs', className)} {...props} />
);

export const CardHeader = ({ className, ...props }: ComponentProps<'div'>) => (
  <div className={cn('flex flex-col gap-1.5 p-5 pb-3', className)} {...props} />
);

export const CardTitle = ({ className, ...props }: ComponentProps<'h3'>) => (
  <h3 className={cn('text-base font-semibold leading-none tracking-tight', className)} {...props} />
);

export const CardDescription = ({ className, ...props }: ComponentProps<'p'>) => (
  <p className={cn('text-sm text-muted-foreground', className)} {...props} />
);

export const CardContent = ({ className, ...props }: ComponentProps<'div'>) => (
  <div className={cn('p-5 pt-0', className)} {...props} />
);
