import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useRef } from 'react';
import { cn } from '../lib/utils';
import { TableCell, TableHead, TableRow } from './ui/table';

export type Column<Row> = {
  key: string;
  header: ReactNode;
  className?: string;
  cell: (row: Row) => ReactNode;
};

/**
 * Fills its flex parent and scrolls internally; only the visible rows are mounted.
 * Spacer rows keep native table column sizing, unlike absolutely positioned rows.
 */
export const VirtualTable = <Row,>({
  rows,
  columns,
  rowKey,
  estimateRowHeight = 44,
  className,
}: {
  rows: Row[];
  columns: Column<Row>[];
  rowKey: (row: Row) => string;
  estimateRowHeight?: number;
  className?: string;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 10,
  });
  const items = virtualizer.getVirtualItems();
  const paddingTop = items[0]?.start ?? 0;
  const paddingBottom = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0);

  return (
    <div ref={scrollRef} className={cn('min-h-0 flex-1 overflow-auto rounded-xl border', className)}>
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-background [&_tr]:border-b">
          <tr>
            {columns.map((column) => (
              <TableHead key={column.key} className={column.className}>
                {column.header}
              </TableHead>
            ))}
          </tr>
        </thead>
        <tbody>
          {paddingTop > 0 ? (
            <tr aria-hidden>
              <td style={{ height: paddingTop }} />
            </tr>
          ) : null}
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <TableRow key={rowKey(row)} data-index={item.index} ref={virtualizer.measureElement}>
                {columns.map((column) => (
                  <TableCell key={column.key} className={column.className}>
                    {column.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
          {paddingBottom > 0 ? (
            <tr aria-hidden>
              <td style={{ height: paddingBottom }} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
};
