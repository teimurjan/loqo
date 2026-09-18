import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { projects, resources, targets } from '../../db/schema';
import { resolveGuards } from '../guards/resolve';
import { type LayerCatalog, layersSignature, loadLayerCatalog, resolveLayers, scopeOf } from '../layers/resolve';
import { type Outcome, type PipelineDeps, runGroup, type TargetGroup, type TargetJob } from '../pipeline/run';
import { buildPromptContext, type NativeExample } from '../prompts/context';
import { createLimiter, type Limiter } from './limiter';
import type { JobOutcome, QueuedJob, TranslateQueue } from './types';

const NATIVE_EXAMPLE_LIMIT = 5;
/**
 * Two fetches in flight: while one batch's last groups drain, the other's are already running, so
 * the limiter stays full. More pollers would only claim more jobs to sit idle behind the limiter.
 */
const POLLERS = 2;

export type WorkerOptions = {
  /** Targets one model call carries; a bigger group is split into calls of this size. */
  fieldsPerCall: number;
  /** Groups — chains of one call per layer — in flight at once, across the whole process. */
  concurrency: number;
};

const loadTargetJobs = async (db: Db, targetIds: string[]): Promise<Map<string, TargetJob>> => {
  if (targetIds.length === 0) return new Map();
  const rows = await db
    .select({ target: targets, resource: resources, project: projects })
    .from(targets)
    .innerJoin(resources, eq(resources.id, targets.resourceId))
    .innerJoin(projects, eq(projects.id, resources.projectId))
    .where(inArray(targets.id, targetIds));
  return new Map(rows.map((row) => [row.target.id, row]));
};

/** Native-approved translations in the same project and locale, newest first, as few-shot material. */
const loadNativeExamples = async (db: Db, projectId: string, locale: string): Promise<NativeExample[]> => {
  const rows = await db
    .select({ source: resources.source, target: targets.value })
    .from(targets)
    .innerJoin(resources, eq(resources.id, targets.resourceId))
    .where(and(eq(resources.projectId, projectId), eq(targets.locale, locale), eq(targets.native, true), isNotNull(targets.value)))
    .orderBy(desc(targets.updatedAt))
    .limit(NATIVE_EXAMPLE_LIMIT);
  return rows.flatMap((row) => (row.target ? [{ source: row.source, target: row.target }] : []));
};

const skipReason = (job: TargetJob, force: boolean): string | null => {
  if (!job.resource.translatable) return 'resource is not translatable';
  if (job.target.status === 'skipped') return 'target is skipped for this locale';
  if (job.target.pinned) return 'target is pinned';
  if (!force && job.target.status === 'translated' && job.target.sourceRevision === job.resource.sourceRevision) {
    return 'target is already current';
  }
  return null;
};

type Deps = PipelineDeps;

/**
 * Turns a batch of per-target jobs into as few model calls as possible: targets whose resolved
 * layer stacks are identical (same project, locale and rendered prompts) share one call per layer.
 */
export const groupJobs = async (
  deps: Deps,
  catalog: LayerCatalog,
  jobs: TargetJob[],
): Promise<{ groups: TargetGroup[]; unresolved: TargetJob[] }> => {
  const groups = new Map<string, TargetGroup>();
  const unresolved: TargetJob[] = [];
  const nativeCache = new Map<string, Promise<NativeExample[]>>();

  for (const job of jobs) {
    const cacheKey = `${job.project.id}:${job.target.locale}`;
    const nativeExamples = await (nativeCache.get(cacheKey) ??
      nativeCache.set(cacheKey, loadNativeExamples(deps.db, job.project.id, job.target.locale)).get(cacheKey));
    const context = buildPromptContext({
      project: job.project,
      resource: job.resource,
      locale: job.target.locale,
      localeNames: deps.config.localeNames,
      nativeExamples: nativeExamples ?? [],
    });
    const scope = scopeOf(catalog, job);
    const layers = resolveLayers(catalog, scope, context);
    if (layers.length === 0) {
      unresolved.push(job);
      continue;
    }
    const key = `${job.project.id}:${job.target.locale}:${layersSignature(layers)}`;
    const group = groups.get(key) ?? { project: job.project, locale: job.target.locale, layers, jobs: [] };
    group.jobs.push({ ...job, guards: resolveGuards(deps.config, catalog.guardRules, scope) });
    groups.set(key, group);
  }
  return { groups: [...groups.values()], unresolved };
};

/** Splits every group into runs of at most `size` jobs: what one model call carries. */
export const chunkGroups = (groups: TargetGroup[], size: number): TargetGroup[] =>
  groups.flatMap((group) =>
    Array.from({ length: Math.ceil(group.jobs.length / size) }, (_, index) => ({ ...group, jobs: group.jobs.slice(index * size, (index + 1) * size) })),
  );

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Report = (targetId: string, outcome: JobOutcome) => void;

/** A stage that throws fails the whole group, and the queue retries each of its jobs. */
const runOne = async (deps: Deps, group: TargetGroup, report: Report): Promise<void> => {
  let results: Map<string, Outcome>;
  try {
    results = await runGroup(deps, group);
  } catch (error) {
    for (const job of group.jobs) report(job.target.id, { status: 'failed', error: errorMessage(error) });
    return;
  }
  for (const job of group.jobs) {
    const outcome = results.get(job.target.id);
    if (!outcome) continue;
    report(job.target.id, outcome.kind === 'translated' ? { status: 'completed', output: { value: outcome.value } } : { status: 'failed', error: outcome.reason });
  }
};

/** One batch: skip what no longer needs work, group the rest, run the groups through the limiter, report per job. */
const handleBatch = async (deps: Deps, limit: Limiter, fieldsPerCall: number, jobs: QueuedJob[]): Promise<Map<string, JobOutcome>> => {
  const outcomes = new Map<string, JobOutcome>();
  const catalog = await loadLayerCatalog(deps.db);
  const loaded = await loadTargetJobs(
    deps.db,
    jobs.map((job) => job.data.targetId),
  );

  const runnable: { jobId: string; target: TargetJob }[] = [];
  for (const job of jobs) {
    const target = loaded.get(job.data.targetId);
    if (!target) {
      outcomes.set(job.id, { status: 'completed', output: { skipped: 'target no longer exists' } });
      continue;
    }
    const reason = skipReason(target, job.data.force ?? false);
    if (reason) {
      if (target.target.status === 'queued') {
        await deps.db.update(targets).set({ status: target.target.value ? 'translated' : 'pending' }).where(eq(targets.id, target.target.id));
      }
      outcomes.set(job.id, { status: 'completed', output: { skipped: reason } });
      continue;
    }
    runnable.push({ jobId: job.id, target });
  }

  const jobIdByTarget = new Map(runnable.map((entry) => [entry.target.target.id, entry.jobId]));
  const report: Report = (targetId, outcome) => {
    const jobId = jobIdByTarget.get(targetId);
    if (jobId) outcomes.set(jobId, outcome);
  };
  const { groups, unresolved } = await groupJobs(
    deps,
    catalog,
    runnable.map((entry) => entry.target),
  );

  for (const job of unresolved) {
    await deps.db.update(targets).set({ status: 'failed', lastError: 'no layer applies to this target', updatedAt: new Date() }).where(eq(targets.id, job.target.id));
    report(job.target.id, { status: 'deadletter', error: 'no layer applies to this target' });
  }

  await Promise.all(chunkGroups(groups, fieldsPerCall).map((group) => limit(() => runOne(deps, group, report))));
  return outcomes;
};

/** Each fetch claims enough jobs to fill the limiter on its own, so a locale's jobs arrive together and merge into full calls. */
export const startWorker = (queue: TranslateQueue, deps: Deps, options: WorkerOptions): Promise<void> => {
  const limit = createLimiter(options.concurrency);
  return queue.work((jobs) => handleBatch(deps, limit, options.fieldsPerCall, jobs), {
    batchSize: options.fieldsPerCall * options.concurrency,
    concurrency: POLLERS,
  });
};
