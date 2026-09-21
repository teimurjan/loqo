import type { ReactNode } from 'react';
import { Sheet, SheetContent } from '../ui/sheet';

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="grid gap-2">
    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
    {children}
  </section>
);

export const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex items-baseline justify-between gap-3 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className="min-w-0 truncate text-right font-mono text-xs">{children}</span>
  </div>
);

/** The details drawer a canvas opens for its selected node. */
export const NodeSheet = ({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) => (
  <Sheet open={open} onOpenChange={(isOpen) => (isOpen ? undefined : onClose())}>
    <SheetContent className="w-full overflow-y-auto p-6 sm:max-w-lg">{children}</SheetContent>
  </Sheet>
);
