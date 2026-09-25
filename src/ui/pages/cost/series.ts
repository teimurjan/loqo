import type { DailyCostRow } from '../../../core/ops/service';

export const OTHER = 'Other';

export type SpendDay = { day: string; values: Record<string, number> };
export type StackedSeries = { keys: string[]; data: SpendDay[] };

const DAY_MS = 86_400_000;

/** Every calendar day from `first` to `last` inclusive, as YYYY-MM-DD, so quiet days read as gaps instead of vanishing. */
const daysBetween = (first: string, last: string): string[] => {
  const start = Date.parse(`${first}T00:00:00Z`);
  const count = Math.round((Date.parse(`${last}T00:00:00Z`) - start) / DAY_MS) + 1;
  return Array.from({ length: count }, (_, index) => new Date(start + index * DAY_MS).toISOString().slice(0, 10));
};

/**
 * Keeps the `topN` costliest groups and folds the rest into Other. Kept groups sort by name, so a
 * group keeps its slot (and colour) when a filter changes the ranking.
 */
export const toStackedSeries = (rows: DailyCostRow[], options: { topN: number; nullLabel: string }): StackedSeries => {
  if (rows.length === 0) return { keys: [], data: [] };
  const labelOf = (row: DailyCostRow) => row.group ?? options.nullLabel;

  const totals = new Map<string, number>();
  for (const row of rows) totals.set(labelOf(row), (totals.get(labelOf(row)) ?? 0) + (row.costUsd ?? 0));
  const ranked = [...totals].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  const kept = new Set(ranked.slice(0, options.topN));
  const keys = [...kept].sort((a, b) => a.localeCompare(b));
  if (ranked.length > options.topN) keys.push(OTHER);

  const days = rows.map((row) => row.day).sort();
  const byDay = new Map(daysBetween(days[0] ?? '', days.at(-1) ?? '').map((day) => [day, Object.fromEntries(keys.map((key) => [key, 0]))]));
  for (const row of rows) {
    const values = byDay.get(row.day);
    if (!values) continue;
    const key = kept.has(labelOf(row)) ? labelOf(row) : OTHER;
    values[key] = (values[key] ?? 0) + (row.costUsd ?? 0);
  }
  return { keys, data: [...byDay].map(([day, values]) => ({ day, values })) };
};
