export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** At most `max` tasks run at once; the rest wait their turn in the order they arrived. */
export const createLimiter = (max: number): Limiter => {
  let active = 0;
  const waiting: (() => void)[] = [];

  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < max) {
        active += 1;
        resolve();
        return;
      }
      waiting.push(() => {
        active += 1;
        resolve();
      });
    });

  const release = (): void => {
    active -= 1;
    waiting.shift()?.();
  };

  return async (task) => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
};
