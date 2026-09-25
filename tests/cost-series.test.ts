import { describe, expect, test } from 'bun:test';
import { OTHER, toStackedSeries } from '../src/ui/pages/cost/series';

describe('toStackedSeries', () => {
  test('keeps the costliest groups sorted by name and folds the rest into Other', () => {
    const series = toStackedSeries(
      [
        { day: '2026-09-01', group: 'zeta', costUsd: 9 },
        { day: '2026-09-01', group: 'alpha', costUsd: 5 },
        { day: '2026-09-01', group: 'cheap', costUsd: 1 },
        { day: '2026-09-01', group: 'cheaper', costUsd: 0.5 },
      ],
      { topN: 2, nullLabel: '(none)' },
    );
    expect(series.keys).toEqual(['alpha', 'zeta', OTHER]);
    expect(series.data).toEqual([{ day: '2026-09-01', values: { alpha: 5, zeta: 9, [OTHER]: 1.5 } }]);
  });

  test('fills quiet days with zero, counts unpriced as zero and labels a missing group', () => {
    const series = toStackedSeries(
      [
        { day: '2026-08-31', group: null, costUsd: 2 },
        { day: '2026-09-02', group: null, costUsd: null },
      ],
      { topN: 5, nullLabel: 'Spend' },
    );
    expect(series.keys).toEqual(['Spend']);
    expect(series.data).toEqual([
      { day: '2026-08-31', values: { Spend: 2 } },
      { day: '2026-09-01', values: { Spend: 0 } },
      { day: '2026-09-02', values: { Spend: 0 } },
    ]);
  });
});
