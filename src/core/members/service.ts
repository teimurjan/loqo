import { and, asc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { type MemberRole, type ProjectMember, projectMembers, projects, users } from '../../db/schema';

export { hasRole, ROLE_RANK } from './roles';

export type MemberWithUser = ProjectMember & { user: { name: string; avatarUrl: string | null } | null };

export type Membership = { projectId: string; projectSlug: string; role: MemberRole };

export type MemberError = 'last-admin';

export type MemberResult = { ok: true; member: ProjectMember | null } | { ok: false; error: MemberError };

export const listMembers = async (db: Db, projectId: string): Promise<MemberWithUser[]> => {
  const rows = await db
    .select({ member: projectMembers, name: users.name, avatarUrl: users.avatarUrl })
    .from(projectMembers)
    .leftJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(projectMembers.createdAt));
  return rows.map(({ member, name, avatarUrl }) => ({ ...member, user: name === null ? null : { name, avatarUrl } }));
};

export const memberships = async (db: Db, userId: string): Promise<Membership[]> =>
  db
    .select({ projectId: projectMembers.projectId, projectSlug: projects.slug, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, userId))
    .orderBy(asc(projects.name));

export const roleFor = async (db: Db, projectId: string, userId: string): Promise<MemberRole | null> => {
  const [row] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
};

export type InviteInput = { projectId: string; email: string; role: MemberRole; invitedBy: string | null };

/** Adds a member by email; an existing account is linked immediately, otherwise on its first sign-in. Re-inviting re-roles. */
export const invite = async (db: Db, input: InviteInput): Promise<MemberResult> => {
  const email = input.email.trim().toLowerCase();
  const [existing] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, input.projectId), eq(projectMembers.email, email)))
    .limit(1);
  if (existing) return setRole(db, input.projectId, existing.id, input.role);
  const [account] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  const linked = account ? { userId: account.id, acceptedAt: new Date() } : {};
  const [row] = await db
    .insert(projectMembers)
    .values({ projectId: input.projectId, email, role: input.role, invitedBy: input.invitedBy, ...linked })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return { ok: true, member: row };
};

const otherActiveAdmins = async (db: Db, member: ProjectMember): Promise<number> => {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, member.projectId), eq(projectMembers.role, 'admin'), isNotNull(projectMembers.userId), ne(projectMembers.id, member.id)));
  return row?.total ?? 0;
};

const getMember = async (db: Db, projectId: string, id: string): Promise<ProjectMember | null> => {
  const [row] = await db.select().from(projectMembers).where(and(eq(projectMembers.id, id), eq(projectMembers.projectId, projectId))).limit(1);
  return row ?? null;
};

/** A project must keep at least one signed-in admin, or nobody could manage it again. */
const guardsLastAdmin = (member: ProjectMember): boolean => member.role === 'admin' && member.userId !== null;

export const setRole = async (db: Db, projectId: string, id: string, role: MemberRole): Promise<MemberResult> => {
  const member = await getMember(db, projectId, id);
  if (!member) return { ok: true, member: null };
  if (role !== 'admin' && guardsLastAdmin(member) && (await otherActiveAdmins(db, member)) === 0) return { ok: false, error: 'last-admin' };
  const [row] = await db.update(projectMembers).set({ role }).where(eq(projectMembers.id, id)).returning();
  return { ok: true, member: row ?? null };
};

export const removeMember = async (db: Db, projectId: string, id: string): Promise<MemberResult> => {
  const member = await getMember(db, projectId, id);
  if (!member) return { ok: true, member: null };
  if (guardsLastAdmin(member) && (await otherActiveAdmins(db, member)) === 0) return { ok: false, error: 'last-admin' };
  await db.delete(projectMembers).where(eq(projectMembers.id, id));
  return { ok: true, member };
};
