import { z } from 'zod';
import { recordAudit } from '../../core/audit/service';
import { upsertGuardRule } from '../../core/guards/rules';
import { createLayer, createPrompt, REASONING_EFFORTS, upsertOverride } from '../../core/layers/service';
import { explainFlow } from '../../core/scenarios/flow';
import { createScenario, deleteScenario, getScenario, listScenarios, updateScenario } from '../../core/scenarios/service';
import type { MemberRole } from '../../db/schema';
import { type AppContext, actorOf, type RequestContext, route } from '../context';
import { HttpError, json, notFound, parseBody } from '../http';
import { requireProject } from './projects';

const reasoning = z.enum(REASONING_EFFORTS).nullable().optional();

/** `provider:model`, the only spelling the registry resolves. */
export const modelRef = z.string().regex(/^[\w.-]+:[\w./:-]+$/, 'expected provider:model');

const scenarioInput = z.object({ name: z.string().trim().min(1), tags: z.array(z.string().trim().min(1)).default([]) });

export const layerInput = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  position: z.number().int(),
  model: modelRef,
  reasoningEffort: reasoning,
  enabled: z.boolean().optional(),
  description: z.string().nullable().optional(),
});

export const promptInput = z.object({
  layerId: z.uuid().nullable(),
  name: z.string().min(1),
  position: z.number().int().optional(),
  enabled: z.boolean().optional(),
  body: z.string().min(1),
});

const overrideInput = z.object({
  layerId: z.uuid(),
  model: modelRef.nullable().optional(),
  reasoningEffort: reasoning,
  enabled: z.boolean().nullable().optional(),
});

export const guardRuleInput = z.object({ guard: z.string().min(1), params: z.record(z.string(), z.unknown()).default({}), enabled: z.boolean().default(true) });

/** Parameters are validated by the kind's own schema, so a bad rule never reaches the worker. */
export const parseGuardParams = (ctx: AppContext, guard: string, params: Record<string, unknown>): Record<string, unknown> => {
  const kind = ctx.config.guardKinds.find((candidate) => candidate.name === guard);
  if (!kind) throw new HttpError(422, `guard "${guard}" is not registered in translate.config.ts`);
  const parsed = kind.params.safeParse(params);
  if (!parsed.success) throw new HttpError(400, 'Invalid guard params', parsed.error.issues);
  return parsed.data as Record<string, unknown>;
};

const builtinScenario = () => new HttpError(403, 'built-in scenario is read-only; attach prompts, layers or guards to it instead');

export const scenarioRoutes = (ctx: AppContext) => {
  const r = route(ctx);

  const requireScenario = async (rc: RequestContext, params: { slug: string; id: string }, min: MemberRole) => {
    const project = await requireProject(rc, params.slug, min);
    const scenario = await getScenario(rc.db, params.id);
    if (!scenario || scenario.projectId !== project.id) throw notFound('scenario');
    return { project, scenario };
  };

  type Owner = Awaited<ReturnType<typeof requireScenario>>;

  const created = async (rc: RequestContext, owner: Owner, action: string, body: unknown, detail: Record<string, unknown>): Promise<Response> => {
    await recordAudit(rc.db, { actor: actorOf(rc), action, projectId: owner.project.id, detail: { scenario: owner.scenario.name, ...detail } });
    return json(body, 201);
  };

  return {
    '/api/projects/:slug/scenarios': {
      GET: r<'/api/projects/:slug/scenarios'>(async (req, rc) => {
        const project = await requireProject(rc, req.params.slug, 'reader');
        return json(await listScenarios(rc.db, project.id));
      }),
      POST: r<'/api/projects/:slug/scenarios'>(async (req, rc) => {
        const project = await requireProject(rc, req.params.slug, 'admin');
        const scenario = await createScenario(rc.db, project.id, await parseBody(req, scenarioInput));
        await recordAudit(rc.db, { actor: actorOf(rc), action: 'scenario.create', projectId: project.id, detail: { name: scenario.name, tags: scenario.tags } });
        return json(scenario, 201);
      }),
    },
    '/api/projects/:slug/scenarios/:id': {
      PATCH: r<'/api/projects/:slug/scenarios/:id'>(async (req, rc) => {
        const { project, scenario } = await requireScenario(rc, req.params, 'admin');
        if (scenario.builtin) throw builtinScenario();
        const input = await parseBody(req, scenarioInput.partial());
        const updated = await updateScenario(rc.db, scenario.id, input);
        await recordAudit(rc.db, { actor: actorOf(rc), action: 'scenario.update', projectId: project.id, detail: { name: scenario.name, ...input } });
        return json(updated);
      }),
      DELETE: r<'/api/projects/:slug/scenarios/:id'>(async (req, rc) => {
        const { project, scenario } = await requireScenario(rc, req.params, 'admin');
        if (scenario.builtin) throw builtinScenario();
        await deleteScenario(rc.db, scenario.id);
        await recordAudit(rc.db, { actor: actorOf(rc), action: 'scenario.delete', projectId: project.id, detail: { name: scenario.name } });
        return json({ ok: true });
      }),
    },
    /** What would run for a resource of this scenario — the graph the flow page draws. */
    '/api/projects/:slug/scenarios/:id/flow': {
      GET: r<'/api/projects/:slug/scenarios/:id/flow'>(async (req, rc) => {
        const { project, scenario } = await requireScenario(rc, req.params, 'reader');
        return json(await explainFlow(rc, project, scenario));
      }),
    },
    '/api/projects/:slug/scenarios/:id/layers': {
      POST: r<'/api/projects/:slug/scenarios/:id/layers'>(async (req, rc) => {
        const owner = await requireScenario(rc, req.params, 'admin');
        const layer = await createLayer(rc.db, { ...(await parseBody(req, layerInput)), scope: 'scenario', scopeRef: owner.scenario.id });
        return created(rc, owner, 'layer.create', layer, { name: layer.name, model: layer.model });
      }),
    },
    '/api/projects/:slug/scenarios/:id/prompts': {
      POST: r<'/api/projects/:slug/scenarios/:id/prompts'>(async (req, rc) => {
        const owner = await requireScenario(rc, req.params, 'admin');
        const prompt = await createPrompt(rc.db, { ...(await parseBody(req, promptInput)), scope: 'scenario', scopeRef: owner.scenario.id });
        return created(rc, owner, 'prompt.create', prompt, { name: prompt.name, layerId: prompt.layerId });
      }),
    },
    '/api/projects/:slug/scenarios/:id/overrides': {
      POST: r<'/api/projects/:slug/scenarios/:id/overrides'>(async (req, rc) => {
        const owner = await requireScenario(rc, req.params, 'admin');
        const override = await upsertOverride(rc.db, { ...(await parseBody(req, overrideInput)), scope: 'scenario', scopeRef: owner.scenario.id });
        return created(rc, owner, 'override.upsert', override, { layerId: override.layerId, model: override.model, reasoningEffort: override.reasoningEffort, enabled: override.enabled });
      }),
    },
    '/api/projects/:slug/scenarios/:id/guard-rules': {
      POST: r<'/api/projects/:slug/scenarios/:id/guard-rules'>(async (req, rc) => {
        const owner = await requireScenario(rc, req.params, 'admin');
        const input = await parseBody(req, guardRuleInput);
        const rule = await upsertGuardRule(rc.db, { ...input, params: parseGuardParams(rc, input.guard, input.params), scope: 'scenario', scopeRef: owner.scenario.id });
        return created(rc, owner, 'guard-rule.upsert', rule, { guard: rule.guard, params: rule.params, enabled: rule.enabled });
      }),
    },
  };
};
