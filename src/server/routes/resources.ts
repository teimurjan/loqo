import { z } from 'zod';
import { recordAudit } from '../../core/audit/service';
import { getResource, getTarget, retranslate, setNative, setPinned, setValue } from '../../core/resources/service';
import type { MemberRole } from '../../db/schema';
import { requireProjectRole } from '../authz';
import { type AppContext, actorOf, type RequestContext, route } from '../context';
import { json, notFound, parseBody } from '../http';

/** Targets are reached by id, so the project (and the caller's role on it) comes from a join. */
const requireTarget = async (ctx: RequestContext, id: string, min: MemberRole) => {
  const current = await getTarget(ctx.db, id);
  if (!current) throw notFound('target');
  await requireProjectRole(ctx, current.project, min);
  return current;
};

export const resourceRoutes = (ctx: AppContext) => {
  const r = route(ctx);

  const audit = async (rc: RequestContext, action: string, current: Awaited<ReturnType<typeof getTarget>>, targetId: string, detail: Record<string, unknown>) =>
    recordAudit(rc.db, {
      actor: actorOf(rc),
      action,
      projectId: current?.project.id,
      resourceId: current?.resource.id,
      targetId,
      detail: { locale: current?.target.locale, key: current?.resource.key, ...detail },
    });

  return {
    '/api/resources/:id': {
      GET: r<'/api/resources/:id'>(async (req, rc) => {
        const resource = await getResource(rc.db, req.params.id);
        if (!resource) throw notFound('resource');
        await requireProjectRole(rc, resource.project, 'reader');
        return json(resource);
      }),
    },
    '/api/targets/:id/pin': {
      POST: r<'/api/targets/:id/pin'>(async (req, rc) => {
        const { pinned } = await parseBody(req, z.object({ pinned: z.boolean() }));
        const current = await requireTarget(rc, req.params.id, 'editor');
        const target = await setPinned(rc.db, req.params.id, pinned);
        if (!target) throw notFound('target');
        await audit(rc, pinned ? 'target.pin' : 'target.unpin', current, target.id, {});
        return json(target);
      }),
    },
    '/api/targets/:id/native': {
      POST: r<'/api/targets/:id/native'>(async (req, rc) => {
        const { native } = await parseBody(req, z.object({ native: z.boolean() }));
        const current = await requireTarget(rc, req.params.id, 'editor');
        const target = await setNative(rc.db, req.params.id, native);
        if (!target) throw notFound('target');
        await audit(rc, native ? 'target.native' : 'target.unnative', current, target.id, {});
        return json(target);
      }),
    },
    '/api/targets/:id/value': {
      PUT: r<'/api/targets/:id/value'>(async (req, rc) => {
        const { value } = await parseBody(req, z.object({ value: z.string() }));
        const before = await requireTarget(rc, req.params.id, 'editor');
        const target = await setValue(rc.db, req.params.id, value);
        if (!target) throw notFound('target');
        await audit(rc, 'target.edit', before, target.id, { before: before.target.value, after: value });
        return json(target);
      }),
    },
    '/api/targets/:id/retranslate': {
      POST: r<'/api/targets/:id/retranslate'>(async (req, rc) => {
        const current = await requireTarget(rc, req.params.id, 'editor');
        const target = await retranslate(rc, req.params.id);
        if (!target) throw notFound('target');
        await audit(rc, 'target.retranslate', current, target.id, {});
        return json(target);
      }),
    },
  };
};
