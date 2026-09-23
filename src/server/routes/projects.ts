import { z } from 'zod';
import { recordAudit } from '../../core/audit/service';
import { invite, listMembers, removeMember, setRole } from '../../core/members/service';
import type { PulledResource } from '../../core/model/types';
import { createProject, deleteProject, getProject, listProjects, updateProject } from '../../core/projects/service';
import { enqueueProject, syncProject } from '../../core/resources/sync';
import { countTargets, decodeTranslationsCursor, listResources, listTranslations, scopeStatus } from '../../core/resources/service';
import { type MemberRole, memberRole, targetStatus } from '../../db/schema';
import { requireProjectRole, visibleProjectIds } from '../authz';
import { type AppContext, actorOf, type RequestContext, requireUser, route } from '../context';
import { HttpError, json, notFound, parseBody, parseOptionalBody, parseQuery } from '../http';

const glossaryEntry = z.object({ term: z.string().min(1), translations: z.record(z.string(), z.string()) });

const projectInput = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes'),
  name: z.string().min(1),
  sourceLocale: z.string().min(2).default('en'),
  targetLocales: z.array(z.string().min(2)).default([]),
  glossary: z.array(glossaryEntry).default([]),
  extraInstructions: z.record(z.string(), z.string()).default({}),
  debounceSeconds: z.number().int().min(0).max(3600).default(60),
});

const pulledTarget = z.object({ value: z.string().optional(), pinned: z.boolean().optional(), native: z.boolean().optional() });

const pulledResource = z.object({
  key: z.string().min(1),
  source: z.string(),
  tags: z.array(z.string()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
  translatable: z.boolean().optional(),
  targets: z.record(z.string(), z.union([z.string(), pulledTarget])).optional(),
});

const memberInput = z.object({ email: z.email(), role: z.enum(memberRole.enumValues) });

const tagList = z.array(z.string().min(1)).min(1);
/** `?tags=a,b` — a scope's tags travel comma-separated in a query string. */
const tagQuery = z
  .string()
  .min(1)
  .transform((value) => value.split(',').map((tag) => tag.trim()).filter(Boolean));
const scopeQuery = { prefix: z.string().min(1).optional(), tags: tagQuery.optional() };

/** Loads the project and checks the caller holds at least `min` on it; unknown and forbidden both 404. */
export const requireProject = async (ctx: RequestContext, slug: string, min: MemberRole) => {
  const project = await getProject(ctx.db, slug);
  if (!project) throw notFound('project');
  await requireProjectRole(ctx, project, min);
  return project;
};

const lastAdmin = () => new HttpError(409, 'A project needs at least one signed-in admin');

export const projectRoutes = (ctx: AppContext) => {
  const r = route(ctx);
  return {
    '/api/projects': {
      GET: r(async (_req, rc) => json(await listProjects(rc.db, { projectIds: await visibleProjectIds(rc) }))),
      POST: r(async (req, rc) => {
        const owner = requireUser(rc);
        const input = await parseBody(req, projectInput);
        const project = await createProject(rc.db, input, owner);
        await recordAudit(rc.db, { actor: actorOf(rc), action: 'project.create', projectId: project.id, detail: { slug: project.slug } });
        return json(project, 201);
      }),
    },
    '/api/projects/:slug': {
      GET: r<'/api/projects/:slug'>(async (req, rc) => json(await requireProject(rc, req.params.slug, 'reader'))),
      PATCH: r<'/api/projects/:slug'>(async (req, rc) => {
        await requireProject(rc, req.params.slug, 'admin');
        const input = await parseBody(req, projectInput.partial());
        const project = await updateProject(rc.db, req.params.slug, input);
        if (!project) throw notFound('project');
        await recordAudit(rc.db, { actor: actorOf(rc), action: 'project.update', projectId: project.id, detail: input });
        return json(project);
      }),
      DELETE: r<'/api/projects/:slug'>(async (req, rc) => {
        const project = await requireProject(rc, req.params.slug, 'admin');
        await deleteProject(rc.db, req.params.slug);
        await recordAudit(rc.db, { actor: actorOf(rc), action: 'project.delete', projectId: project.id, detail: { slug: project.slug } });
        return json({ ok: true });
      }),
    },
    '/api/projects/:slug/members': {
      GET: r<'/api/projects/:slug/members'>(async (req, rc) => {
        const project = await requireProject(rc, req.params.slug, 'reader');
        return json(await listMembers(rc.db, project.id));
      }),
      POST: r<'/api/projects/:slug/members'>(async (req, rc) => {
        const project = await requireProject(rc, req.params.slug, 'admin');
        const input = await parseBody(req, memberInput);
        const result = await invite(rc.db, { projectId: project.id, ...input, invitedBy: rc.principal.kind === 'user' ? rc.principal.user.id : null });
        if (!result.ok) throw lastAdmin();
        if (!result.member) throw notFound('member');
        await recordAudit(rc.db, { actor: actorOf(rc), action: 'member.invite', projectId: project.id, detail: { email: result.member.email, role: result.member.role } });
        return json(result.member, 201);
      }),
    },
    '/api/projects/:slug/members/:id': {
      PATCH: r<'/api/projects/:slug/members/:id'>(async (req, rc) => {
        const project = await requireProject(rc, req.params.slug, 'admin');
        const { role } = await parseBody(req, memberInput.pick({ role: true }));
        const result = await setRole(rc.db, project.id, req.params.id, role);
        if (!result.ok) throw lastAdmin();
        if (!result.member) throw notFound('member');
        await recordAudit(rc.db, { actor: actorOf(rc), action: 'member.role', projectId: project.id, detail: { email: result.member.email, role } });
        return json(result.member);
      }),
      DELETE: r<'/api/projects/:slug/members/:id'>(async (req, rc) => {
        const project = await requireProject(rc, req.params.slug, 'admin');
        const result = await removeMember(rc.db, project.id, req.params.id);
        if (!result.ok) throw lastAdmin();
        if (!result.member) throw notFound('member');
        await recordAudit(rc.db, { actor: actorOf(rc), action: 'member.remove', projectId: project.id, detail: { email: result.member.email } });
        return json({ ok: true });
      }),
    },
    /** An adapter's pull(), delivered over HTTP: a CI step or a CMS plugin sends canonical resources. */
    '/api/projects/:slug/import': {
      POST: r<'/api/projects/:slug/import'>(async (req, rc) => {
        const project = await requireProject(rc, req.params.slug, 'editor');
        const body = await parseBody(
          req,
          z.object({
            resources: z.array(pulledResource),
            prune: z.boolean().default(false),
            prunePrefix: z.string().min(1).optional(),
            pruneTags: tagList.optional(),
            enqueue: z.boolean().default(true),
          }),
        );
        const summary = await syncProject(rc, project, body.resources as PulledResource[], {
          prune: body.prune,
          prunePrefix: body.prunePrefix,
          pruneTags: body.pruneTags,
          enqueue: body.enqueue,
        });
        await recordAudit(rc.db, { actor: actorOf(rc), action: 'project.import', projectId: project.id, detail: { ...summary, duplicates: summary.duplicates.length } });
        return json(summary);
      }),
    },
    '/api/projects/:slug/translate': {
      POST: r<'/api/projects/:slug/translate'>(async (req, rc) => {
        const project = await requireProject(rc, req.params.slug, 'editor');
        const body = await parseOptionalBody(
          req,
          z.object({
            locales: z.array(z.string()).optional(),
            statuses: z.array(z.enum(targetStatus.enumValues)).min(1).optional(),
            force: z.boolean().default(false),
            prefix: z.string().min(1).optional(),
            tags: tagList.optional(),
          }),
        );
        const enqueued = await enqueueProject(rc, project, body);
        await recordAudit(rc.db, { actor: actorOf(rc), action: 'project.translate', projectId: project.id, detail: { ...body, enqueued } });
        return json({ enqueued });
      }),
    },
    '/api/projects/:slug/resources': {
      GET: r<'/api/projects/:slug/resources'>(async (req, rc) => {
        const project = await requireProject(rc, req.params.slug, 'reader');
        const query = parseQuery(
          req,
          z.object({
            q: z.string().optional(),
            prefix: z.string().min(1).optional(),
            status: z.enum(targetStatus.enumValues).optional(),
            locale: z.string().optional(),
            tag: z.string().optional(),
            page: z.coerce.number().int().min(1).default(1),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
        );
        return json(await listResources(rc.db, { projectId: project.id, ...query }));
      }),
    },
    /** An adapter's push(), delivered over HTTP: every translated value, paged, with the resource's meta. */
    '/api/projects/:slug/translations': {
      GET: r<'/api/projects/:slug/translations'>(async (req, rc) => {
        const project = await requireProject(rc, req.params.slug, 'reader');
        const { cursor, ...query } = parseQuery(
          req,
          z.object({
            locale: z.string().optional(),
            prefix: z.string().min(1).optional(),
            updatedSince: z.iso.datetime({ offset: true }).optional(),
            page: z.coerce.number().int().min(1).default(1),
            /** The previous page's `cursor`; it replaces `page`, which makes the database re-walk what it already served. */
            cursor: z.string().min(1).optional(),
            limit: z.coerce.number().int().min(1).max(1000).default(500),
          }),
        );
        const after = cursor ? decodeTranslationsCursor(cursor) : null;
        if (cursor && !after) throw new HttpError(400, 'Invalid cursor');
        return json(
          await listTranslations(rc.db, { projectId: project.id, ...query, after: after ?? undefined, updatedSince: query.updatedSince ? new Date(query.updatedSince) : undefined }),
        );
      }),
    },
    /** Targets by status per tag (`by=tag&tagPrefix=collection:`) or per locale (`by=locale&prefix=pages/1:`). */
    '/api/projects/:slug/counts': {
      GET: r<'/api/projects/:slug/counts'>(async (req, rc) => {
        const project = await requireProject(rc, req.params.slug, 'reader');
        const query = parseQuery(req, z.object({ by: z.enum(['tag', 'locale']), tagPrefix: z.string().min(1).optional(), prefix: z.string().min(1).optional() }));
        return json({ groups: await countTargets(rc.db, { projectId: project.id, ...query }) });
      }),
    },
    /** One scope's standing: targets by status and a digest of its translated values (`?tags=collection:x,ios&prefix=`). */
    '/api/projects/:slug/status': {
      GET: r<'/api/projects/:slug/status'>(async (req, rc) => {
        const project = await requireProject(rc, req.params.slug, 'reader');
        const query = parseQuery(req, z.object(scopeQuery));
        return json(await scopeStatus(rc.db, { projectId: project.id, ...query }));
      }),
    },
  };
};
