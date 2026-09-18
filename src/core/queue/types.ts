export type TranslateJob = { targetId: string; force?: boolean };

export type EnqueueOptions = {
  /** Seconds to hold the job so a burst of source edits produces one translation. */
  debounceSeconds: number;
  /** Re-translate even when the target is already current. */
  force?: boolean;
};

/** A job as the worker receives it: the backend's id travels back with the outcome. */
export type QueuedJob = { id: string; data: TranslateJob };

export type JobOutcome =
  | { status: 'completed'; output?: Record<string, unknown> }
  /** The backend retries it, up to its retry limit. */
  | { status: 'failed'; error: string }
  /** Never retried: retrying cannot change the answer. */
  | { status: 'deadletter'; error: string };

export type JobHandler = (jobs: QueuedJob[]) => Promise<Map<string, JobOutcome>>;

export type WorkOptions = {
  /** Jobs one fetch claims and hands to the handler together. */
  batchSize: number;
  /** Handler invocations in flight at once, each with its own batch. */
  concurrency: number;
};

export type QueueCounts = { queued: number; ready: number; deferred: number; active: number; failed: number; total: number };

/**
 * What the platform asks of a queue, and nothing a particular broker adds: one job per target,
 * a target already waiting is not queued twice, a debounce holds a job back, a failed job is
 * retried. Postgres via pg-boss is the default backend; anything with those guarantees fits.
 */
export interface TranslateQueue {
  enqueue(jobs: TranslateJob[], options: EnqueueOptions): Promise<void>;
  /** Hands batches to `handler` until stopped; every job in a batch gets exactly one outcome. */
  work(handler: JobHandler, options: WorkOptions): Promise<void>;
  /** `null` when the backend cannot count. */
  counts(): Promise<QueueCounts | null>;
  /** Graceful lets active jobs finish (bounded by `timeoutMs`); otherwise they are abandoned to a retry. */
  stop(options: { graceful: boolean; timeoutMs?: number }): Promise<void>;
}
