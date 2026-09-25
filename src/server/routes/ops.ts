import { z } from 'zod';
import { listAudit } from '../../core/audit/service';
import { costByDimension, dailyCost, queueStatus, recentRuns, suspiciousTargets } from '../../core/ops/service';
import { requireProjectRole, visibleProjectIds } from '../authz';
import { type AppContext, type RequestContext, route } from '../context';
import { getProject } from '../../core/projects/service';
import { json, notFound, parseQuery } from '../http';

const projectFilter = z.object({ project: z.string().optional() });
const costFilter = projectFilter.extend({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });

/** `?project=slug` narrows to one project the caller can read; otherwise every project they belong to. */
const projectScope = async (ctx: RequestContext, slug: string | undefined): Promise<string[]> => {
  if (slug) {
    const project = await getProject(ctx.db, slug);
    if (!project) throw notFound('project');
    await requireProjectRole(ctx, project, 'reader');
    return [project.id];
  }
  return visibleProjectIds(ctx);
};

export const opsRoutes = (ctx: AppContext) => {
  const r = route(ctx);
  return {
    '/api/health': {
      GET: () => json({ ok: true, pricing: ctx.pricing.status() }),
    },
    /** Guards, processors and providers are code; the UI only needs their names and shapes. */
    '/api/config': {
      GET: r(async () =>
        json({
          guardKinds: ctx.config.guardKinds.map((kind) => ({
            name: kind.name,
            description: kind.description,
            canRepair: kind.canRepair,
            schema: z.toJSONSchema(kind.params),
          })),
          processors: ctx.config.processors.map((processor) => ({ name: processor.name, stage: processor.stage })),
          repairModel: ctx.config.repairModel ?? null,
        }),
      ),
    },
    '/api/queue': {
      GET: r(async (req, rc) => json(await queueStatus(rc.db, rc.queue, await projectScope(rc, parseQuery(req, projectFilter).project)))),
    },
    '/api/ops/suspicious': {
      GET: r(async (req, rc) => json(await suspiciousTargets(rc.db, await projectScope(rc, parseQuery(req, projectFilter).project)))),
    },
    '/api/analytics/cost': {
      GET: r(async (req, rc) => {
        const query = parseQuery(req, costFilter.extend({ groupBy: z.enum(['project', 'locale', 'layer', 'model', 'day']).default('project') }));
        return json(await costByDimension(rc.db, { ...query, projectIds: await projectScope(rc, query.project) }));
      }),
    },
    '/api/analytics/cost/daily': {
      GET: r(async (req, rc) => {
        const query = parseQuery(req, costFilter.extend({ stackBy: z.enum(['project', 'locale', 'layer', 'model']).optional() }));
        return json(await dailyCost(rc.db, { ...query, projectIds: await projectScope(rc, query.project) }));
      }),
    },
    '/api/analytics/runs': {
      GET: r(async (req, rc) => {
        const { limit, project } = parseQuery(req, projectFilter.extend({ limit: z.coerce.number().int().min(1).max(500).default(100) }));
        return json(await recentRuns(rc.db, limit, await projectScope(rc, project)));
      }),
    },
    '/api/audit': {
      GET: r(async (req, rc) => {
        const query = parseQuery(req, projectFilter.extend({ limit: z.coerce.number().int().min(1).max(500).default(100) }));
        return json(await listAudit(rc.db, { limit: query.limit, projectIds: await projectScope(rc, query.project) }));
      }),
    },
  };
};
