import type { TranslateQueue } from '../../src/core/queue/types';

/** A queue that accepts everything and runs nothing: pipeline tests drive `runGroup` by hand. */
export const noopQueue: TranslateQueue = {
  enqueue: async () => {},
  work: async () => {},
  counts: async () => null,
  stop: async () => {},
};
