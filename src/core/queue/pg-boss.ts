import { type JobResult, PgBoss } from 'pg-boss';
import type { JobOutcome, TranslateJob, TranslateQueue } from './types';

const TRANSLATE_QUEUE = 'translate';

const toJobResult = (id: string, outcome: JobOutcome | undefined): JobResult => {
  if (!outcome) return { id, status: 'failed', output: { error: 'worker reported no outcome' } };
  if (outcome.status === 'completed') return { id, status: 'completed', output: outcome.output };
  return { id, status: outcome.status, output: { error: outcome.error } };
};

/**
 * Postgres is the queue. The `stately` policy plus a per-target `singletonKey` gives Cloud Tasks'
 * dedupe for free: one queued job per target, one active job per target, and `startAfter` is the
 * debounce that lets rapid edits collapse into a single translation.
 */
export const createPgBossQueue = async (connectionString: string): Promise<TranslateQueue> => {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', max: 5 });
  boss.on('error', (error) => console.error('[pg-boss]', error));
  await boss.start();
  await boss.createQueue(TRANSLATE_QUEUE, {
    policy: 'stately',
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 900,
    deleteAfterSeconds: 7 * 24 * 60 * 60,
  });

  return {
    enqueue: async (jobs, options) => {
      await boss.insert(
        TRANSLATE_QUEUE,
        jobs.map((data) => ({ data, singletonKey: data.targetId, startAfter: options.debounceSeconds })),
      );
    },
    work: async (handler, options) => {
      await boss.work<TranslateJob>(
        TRANSLATE_QUEUE,
        {
          batchSize: options.batchSize,
          localConcurrency: options.concurrency,
          perJobResults: true,
          pollingIntervalSeconds: 2,
          burstWhenBatchFull: true,
        },
        async (jobs) => {
          const outcomes = await handler(jobs.map((job) => ({ id: job.id, data: job.data })));
          return jobs.map((job) => toJobResult(job.id, outcomes.get(job.id)));
        },
      );
    },
    counts: async () => {
      const queue = await boss.getQueue(TRANSLATE_QUEUE);
      if (!queue) return null;
      return {
        queued: queue.queuedCount,
        ready: queue.readyCount,
        deferred: queue.deferredCount,
        active: queue.activeCount,
        failed: queue.failedCount,
        total: queue.totalCount,
      };
    },
    stop: (options) => boss.stop({ graceful: options.graceful, timeout: options.timeoutMs, close: true }),
  };
};
