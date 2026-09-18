import { describe, expect, test } from 'bun:test';
import { createLimiter } from '../src/core/queue/limiter';

describe('limiter', () => {
  test('runs at most `max` tasks at once, in arrival order, and frees a slot when a task throws', async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const task = (index: number) => async () => {
      started.push(index);
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active -= 1;
      if (index === 4) throw new Error(`task ${index}`);
      return index;
    };

    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => limit(task(index))));

    expect(peak).toBe(3);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(results.map((result) => (result.status === 'fulfilled' ? result.value : result.reason.message))).toEqual([0, 1, 2, 3, 'task 4', 5, 6, 7]);
    expect(active).toBe(0);
  });
});
