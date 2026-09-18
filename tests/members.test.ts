import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { signIn } from '../src/core/auth/service';
import { createSession, getSession } from '../src/core/auth/session';
import { invite, listMembers, memberships, removeMember, roleFor, setRole } from '../src/core/members/service';
import { createProject } from '../src/core/projects/service';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { projectMembers, projects, users } from '../src/db/schema';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://opendeepl:opendeepl@localhost:5432/opendeepl_test';

const { db, pool } = createDb(DATABASE_URL);

const profile = (n: number) => ({ sub: `sub-${n}`, email: `user${n}@example.com`, name: `User ${n}`, avatarUrl: null });

beforeAll(async () => {
  await runMigrations(db);
  await db.delete(projects);
  await db.delete(users);
});

afterAll(async () => {
  await pool.end();
});

describe('sign-in and membership', () => {
  test('signing in grants nothing by itself', async () => {
    const [existing] = await db.insert(projects).values({ slug: 'existing', name: 'Existing' }).returning();
    if (!existing) throw new Error('no project');
    const first = await signIn(db, profile(1));
    expect(await roleFor(db, existing.id, first.id)).toBeNull();
    expect(await memberships(db, first.id)).toEqual([]);
  });

  test('creator becomes admin; invites link now or on first sign-in', async () => {
    const owner = await signIn(db, profile(3));
    const project = await createProject(db, { slug: 'team', name: 'Team' }, owner);
    expect(await roleFor(db, project.id, owner.id)).toBe('admin');

    const known = await signIn(db, profile(4));
    const linked = await invite(db, { projectId: project.id, email: 'USER4@example.com', role: 'editor', invitedBy: owner.id });
    expect(linked.ok && linked.member?.userId).toBe(known.id);
    expect(linked.ok && linked.member?.acceptedAt).not.toBeNull();

    const pending = await invite(db, { projectId: project.id, email: 'user5@example.com', role: 'reader', invitedBy: owner.id });
    expect(pending.ok && pending.member?.userId).toBeNull();
    const newcomer = await signIn(db, profile(5));
    expect(await roleFor(db, project.id, newcomer.id)).toBe('reader');
    expect((await memberships(db, newcomer.id)).map((entry) => entry.projectSlug)).toEqual(['team']);

    const again = await invite(db, { projectId: project.id, email: 'user5@example.com', role: 'editor', invitedBy: owner.id });
    expect(again.ok && again.member?.role).toBe('editor');
    expect(await listMembers(db, project.id)).toHaveLength(3);
    expect(await invite(db, { projectId: project.id, email: owner.email, role: 'reader', invitedBy: owner.id })).toEqual({ ok: false, error: 'last-admin' });
  });

  test('the last signed-in admin cannot be demoted or removed', async () => {
    const [project] = await db.select().from(projects).where(eq(projects.slug, 'team'));
    if (!project) throw new Error('no project');
    const [admin] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.role, 'admin')));
    if (!admin) throw new Error('no admin');
    expect(await setRole(db, project.id, admin.id, 'reader')).toEqual({ ok: false, error: 'last-admin' });
    expect(await removeMember(db, project.id, admin.id)).toEqual({ ok: false, error: 'last-admin' });

    const [editor] = await db.select().from(projectMembers).where(eq(projectMembers.email, 'user4@example.com'));
    if (!editor) throw new Error('no editor');
    const promoted = await setRole(db, project.id, editor.id, 'admin');
    expect(promoted.ok && promoted.member?.role).toBe('admin');
    const demoted = await setRole(db, project.id, admin.id, 'reader');
    expect(demoted.ok && demoted.member?.role).toBe('reader');
  });

  test('sessions resolve to their user and reject unknown tokens', async () => {
    const [user] = await db.select().from(users).limit(1);
    if (!user) throw new Error('no user');
    const { token } = await createSession(db, user.id);
    expect((await getSession(db, token))?.user.id).toBe(user.id);
    expect(await getSession(db, `${token}x`)).toBeNull();
  });
});
