import { z } from 'zod';
import { createApiKey, deleteApiKey, listApiKeys } from '../../core/api-keys/service';
import { recordAudit } from '../../core/audit/service';
import { memberRole } from '../../db/schema';
import { type AppContext, actorOf, requireUser, route } from '../context';
import { json, notFound, parseBody } from '../http';
import { requireProject } from './projects';

const keyInput = z.object({ name: z.string().trim().min(1).max(80), role: z.enum(memberRole.enumValues) });

/** Admins mint and revoke; a key never manages keys, so stealing one cannot mint another. */
export const apiKeyRoutes = (ctx: AppContext) => {
  const r = route(ctx);
  return {
    '/api/projects/:slug/keys': {
      GET: r<'/api/projects/:slug/keys'>(async (req, rc) => {
        requireUser(rc);
        const project = await requireProject(rc, req.params.slug, 'admin');
        return json(await listApiKeys(rc.db, project.id));
      }),
      POST: r<'/api/projects/:slug/keys'>(async (req, rc) => {
        const user = requireUser(rc);
        const project = await requireProject(rc, req.params.slug, 'admin');
        const input = await parseBody(req, keyInput);
        const created = await createApiKey(rc.db, { projectId: project.id, ...input, createdBy: user.id });
        await recordAudit(rc.db, { actor: actorOf(rc), action: 'key.create', projectId: project.id, detail: { name: created.key.name, role: created.key.role } });
        return json(created, 201);
      }),
    },
    '/api/projects/:slug/keys/:id': {
      DELETE: r<'/api/projects/:slug/keys/:id'>(async (req, rc) => {
        requireUser(rc);
        const project = await requireProject(rc, req.params.slug, 'admin');
        const removed = await deleteApiKey(rc.db, project.id, req.params.id);
        if (!removed) throw notFound('key');
        await recordAudit(rc.db, { actor: actorOf(rc), action: 'key.delete', projectId: project.id, detail: { name: removed.name } });
        return json({ ok: true });
      }),
    },
  };
};
