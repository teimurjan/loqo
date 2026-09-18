import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { ResolvedConfig } from '../../config';
import type { Db } from '../../db/client';
import { type Project, type Resource, type Target, type VerdictOutcome, layerRunTargets, layerRuns, targets, verdicts } from '../../db/schema';
import type { Guard } from '../guards/types';
import type { ResolvedLayer } from '../layers/resolve';
import type { ValueContext } from '../model/types';
import type { Pricing, TokenUsage } from '../pricing';
import type { ValueProcessor } from '../processors/types';
import type { ProviderBackoff } from './backoff';
import type { ModelClient } from './llm';
import { composeStages, llmStage, type Stage, type StageField, type StageResult } from './stage';

export type TargetJob = { target: Target; resource: Resource; project: Project };

/** A job with the guards resolved for its scope: defaults plus scenario rules. */
export type GroupedJob = TargetJob & { guards: Guard[] };

export type TargetGroup = { project: Project; locale: string; layers: ResolvedLayer[]; jobs: GroupedJob[] };

export type Outcome = { kind: 'translated'; value: string } | { kind: 'rejected'; reason: string };

export type PipelineDeps = { db: Db; config: ResolvedConfig; pricing: Pricing; backoff: ProviderBackoff };

type VerdictDraft = { guard: string; outcome: VerdictOutcome; detail?: string; before?: string; after?: string };

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };

export const valueContextOf = (job: TargetJob): ValueContext => ({
  projectSlug: job.project.slug,
  sourceLocale: job.project.sourceLocale,
  locale: job.target.locale,
  key: job.resource.key,
  tags: job.resource.tags,
  meta: job.resource.meta,
});

const applyProcessors = (
  processors: ValueProcessor[],
  stage: ValueProcessor['stage'],
  value: string,
  source: string,
  ctx: ValueContext,
  drafts: VerdictDraft[],
): string =>
  processors
    .filter((processor) => processor.stage === stage && processor.match(ctx))
    .reduce((current, processor) => {
      const next = processor.process(current, source, ctx);
      if (stage === 'output' && next !== current) {
        drafts.push({ guard: processor.name, outcome: 'repair', before: current, after: next });
      }
      return next;
    }, value);

type Rejection = { guard: string; reason: string; repair: Guard['repair']; repairAttempts: number };

/** Every matching guard gets its verdict recorded; the first rejection is the one that drives repair. */
const runGuards = async (guards: Guard[], candidate: string, source: string, ctx: ValueContext, drafts: VerdictDraft[]): Promise<Rejection | null> => {
  let rejection: Rejection | null = null;
  for (const guard of guards) {
    if (!guard.match(ctx)) continue;
    const reason = await guard.check(candidate, source, ctx);
    drafts.push({ guard: guard.name, outcome: reason ? 'reject' : 'pass', detail: reason ?? undefined });
    if (reason && !rejection) rejection = { guard: guard.name, reason, repair: guard.repair, repairAttempts: guard.repairAttempts ?? 1 };
  }
  return rejection;
};

type Run = { runId: string; project: Project; locale: string };

type LedgerEntry = {
  stage: Stage & Required<Pick<Stage, 'model'>>;
  kind: 'layer' | 'repair';
  usage: TokenUsage;
  latencyMs: number;
  targetIds: string[];
  error?: string;
};

const recordRun = async (deps: PipelineDeps, run: Run, entry: LedgerEntry): Promise<void> => {
  const costUsd = await deps.pricing.costUsd(entry.stage.model.ref, entry.usage);
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(layerRuns)
      .values({
        runId: run.runId,
        projectId: run.project.id,
        locale: run.locale,
        layerId: entry.stage.model.layerId,
        layerName: entry.stage.name,
        kind: entry.kind,
        model: entry.stage.model.ref,
        promptVersionIds: entry.stage.model.promptVersionIds,
        targetCount: entry.targetIds.length,
        inputTokens: entry.usage.inputTokens,
        outputTokens: entry.usage.outputTokens,
        reasoningTokens: entry.usage.reasoningTokens,
        cachedInputTokens: entry.usage.cachedInputTokens,
        costUsd,
        latencyMs: entry.latencyMs,
        error: entry.error ?? null,
      })
      .returning({ id: layerRuns.id });
    if (!row) return;
    await tx.insert(layerRunTargets).values(entry.targetIds.map((targetId) => ({ layerRunId: row.id, targetId })));
  });
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const hasModel = (stage: Stage): stage is Stage & Required<Pick<Stage, 'model'>> => stage.model !== undefined;

/**
 * Runs one stage over the fields it is given and keeps the ledger honest: a stage that calls a
 * model gets a `layer_runs` row whether it succeeded or threw. A stage may only speak about the
 * fields it saw; anything else it returns is ignored.
 */
const executeStage = async (deps: PipelineDeps, run: Run, kind: LedgerEntry['kind'], stage: Stage, fields: StageField[]): Promise<StageResult> => {
  const started = Date.now();
  const targetIds = fields.map((field) => field.id);
  const seen = new Set(targetIds);
  try {
    const result = await stage.run({ project: run.project, locale: run.locale, fields });
    if (hasModel(stage)) await recordRun(deps, run, { stage, kind, usage: result.usage ?? NO_USAGE, latencyMs: Date.now() - started, targetIds });
    return {
      fields: Object.fromEntries(Object.entries(result.fields ?? {}).filter(([id]) => seen.has(id))),
      settled: result.settled?.filter((id) => seen.has(id)),
      missing: result.missing?.filter((id) => seen.has(id)),
      usage: result.usage,
    };
  } catch (error) {
    if (hasModel(stage)) {
      await recordRun(deps, run, { stage, kind, usage: NO_USAGE, latencyMs: Date.now() - started, targetIds, error: errorMessage(error) });
    }
    throw error;
  }
};

/** One repair call for one value: a throwaway layer whose prompt the guard wrote. */
const repairStage = (models: ModelClient, guard: string, model: string, prompt: string): Stage =>
  llmStage(models, { layerId: null, name: `repair:${guard}`, position: 0, model, reasoningEffort: null, systemPrompt: prompt, promptVersionIds: [] });

/**
 * One pass through the pipeline for a group of targets that share a project, a locale and a
 * resolved layer stack: source processors → every stage in position order → per-target output
 * processors, guards, the repair calls the guards asked for → persist. A stage that throws fails
 * the whole group (the queue retries each job); a guard rejection is a per-target outcome.
 */
export const runGroup = async (deps: PipelineDeps, group: TargetGroup): Promise<Map<string, Outcome>> => {
  const { config } = deps;
  const models: ModelClient = { providers: config.providers, backoff: deps.backoff };
  const run: Run = { runId: randomUUID(), project: group.project, locale: group.locale };
  const targetIds = group.jobs.map((job) => job.target.id);
  await deps.db.update(targets).set({ status: 'translating', updatedAt: new Date() }).where(inArray(targets.id, targetIds));

  const entries = new Map(group.jobs.map((job) => [job.target.id, { job, ctx: valueContextOf(job) }]));
  const lookup = (id: string) => {
    const entry = entries.get(id);
    if (!entry) throw new Error(`target ${id} vanished from its group`);
    return entry;
  };

  const texts = new Map([...entries].map(([id, { job, ctx }]) => [id, applyProcessors(config.processors, 'source', job.resource.source, job.resource.source, ctx, [])]));
  // A settled field is done; an unanswered one is rejected below. Neither goes to another stage.
  const settled = new Set<string>();
  const unanswered = new Map<string, string>();

  for (const stage of composeStages(models, config.stages, group.layers)) {
    const fields: StageField[] = [...entries]
      .filter(([id, { ctx }]) => !settled.has(id) && !unanswered.has(id) && stage.match(ctx))
      .map(([id, { job, ctx }]) => ({ id, text: texts.get(id) ?? job.resource.source, source: job.resource.source, ctx }));
    if (fields.length === 0) continue;

    let result: StageResult;
    try {
      result = await executeStage(deps, run, 'layer', stage, fields);
    } catch (error) {
      await deps.db
        .update(targets)
        .set({ status: 'failed', lastError: errorMessage(error), updatedAt: new Date() })
        .where(inArray(targets.id, targetIds));
      throw error;
    }
    for (const [id, text] of Object.entries(result.fields ?? {})) texts.set(id, text);
    for (const id of result.settled ?? []) settled.add(id);
    for (const id of result.missing ?? []) unanswered.set(id, stage.name);
  }

  const lastLayerModel = group.layers.at(-1)?.model ?? config.repairModel;
  const outcomes = new Map<string, Outcome>();

  for (const id of targetIds) {
    const { job, ctx } = lookup(id);
    const source = job.resource.source;
    const drafts: VerdictDraft[] = [];

    let candidate = applyProcessors(config.processors, 'output', texts.get(id) ?? source, source, ctx, drafts);
    const stageName = unanswered.get(id);
    let rejection: Rejection | null;
    if (stageName === undefined) {
      rejection = await runGuards(job.guards, candidate, source, ctx, drafts);
    } else {
      const reason = `layer "${stageName}" returned no value`;
      rejection = { guard: stageName, reason, repair: undefined, repairAttempts: 0 };
      drafts.push({ guard: stageName, outcome: 'reject', detail: reason });
    }

    // Each guard gets the repair calls it asked for; a value whose repair trips a different guard moves on to that one's budget.
    const attempts = new Map<string, number>();
    while (rejection) {
      const spent = attempts.get(rejection.guard) ?? 0;
      const instruction = spent < rejection.repairAttempts ? ((await rejection.repair?.(candidate, source, ctx, rejection.reason)) ?? null) : null;
      const repairModel = instruction?.model ?? config.repairModel ?? lastLayerModel;
      if (!instruction || !repairModel) break;
      attempts.set(rejection.guard, spent + 1);
      try {
        const repaired = await executeStage(deps, run, 'repair', repairStage(models, rejection.guard, repairModel, instruction.prompt), [{ id, text: candidate, source, ctx }]);
        candidate = applyProcessors(config.processors, 'output', repaired.fields?.[id] ?? candidate, source, ctx, drafts);
        rejection = await runGuards(job.guards, candidate, source, ctx, drafts);
      } catch {
        break;
      }
    }

    await deps.db.transaction(async (tx) => {
      if (drafts.length > 0) {
        await tx.insert(verdicts).values(drafts.map((draft) => ({ ...draft, targetId: id, runId: run.runId })));
      }
      if (rejection) {
        await tx
          .update(targets)
          .set({ status: 'rejected', lastError: rejection.reason, updatedAt: new Date() })
          .where(eq(targets.id, id));
      } else {
        await tx
          .update(targets)
          .set({
            value: candidate,
            status: 'translated',
            origin: 'machine',
            native: false,
            sourceRevision: job.resource.sourceRevision,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(targets.id, id));
      }
    });

    outcomes.set(id, rejection ? { kind: 'rejected', reason: rejection.reason } : { kind: 'translated', value: candidate });
  }

  return outcomes;
};
