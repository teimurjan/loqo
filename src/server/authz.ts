import { hasRole, memberships, roleFor } from '../core/members/service';
import type { MemberRole } from '../db/schema';
import type { RequestContext } from './context';
import { HttpError, notFound } from './http';

/** A key sees only its own project; a user sees the projects they belong to. */
const roleOn = async (ctx: RequestContext, projectId: string): Promise<MemberRole | null> => {
  if (ctx.principal.kind === 'key') return ctx.principal.project.id === projectId ? ctx.principal.key.role : null;
  return roleFor(ctx.db, projectId, ctx.principal.user.id);
};

/**
 * Membership gate. Outsiders get the same 404 as a project that does not exist, so the API never
 * confirms a slug to someone who was not invited.
 */
export const requireProjectRole = async (ctx: RequestContext, project: { id: string }, min: MemberRole): Promise<void> => {
  const role = await roleOn(ctx, project.id);
  if (role === null) throw notFound('project');
  if (!hasRole(role, min)) throw new HttpError(403, 'Forbidden');
};

export const visibleProjectIds = async (ctx: RequestContext): Promise<string[]> => {
  if (ctx.principal.kind === 'key') return [ctx.principal.project.id];
  return (await memberships(ctx.db, ctx.principal.user.id)).map((membership) => membership.projectId);
};
