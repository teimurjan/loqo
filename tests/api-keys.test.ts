import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { authenticateApiKey, createApiKey, deleteApiKey, listApiKeys } from '../src/core/api-keys/service';
import { signIn } from '../src/core/auth/service';
import { createProject } from '../src/core/projects/service';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { type Project, apiKeys, projects, users } from '../src/db/schema';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://opendeepl:opendeepl@localhost:5432/opendeepl_test';

const { db, pool } = createDb(DATABASE_URL);
let project: Project;
let other: Project;

beforeAll(async () => {
  await runMigrations(db);
  await db.delete(projects);
  await db.delete(users);
  const owner = await signIn(db, { sub: 'keys-owner', email: 'keys@example.com', name: 'Keys', avatarUrl: null });
  project = await createProject(db, { slug: 'keyed', name: 'Keyed' }, owner);
  other = await createProject(db, { slug: 'other', name: 'Other' }, owner);
});

afterAll(async () => {
  await pool.end();
});

describe('project API keys', () => {
  test('the token is returned once; the list carries a prefix and never the token or its hash', async () => {
    const { key, token } = await createApiKey(db, { projectId: project.id, name: '  ci  ', role: 'editor', createdBy: null });
    expect(token).toMatch(/^odl_[A-Za-z0-9_-]{43}$/);
    expect(key).not.toHaveProperty('keyHash');
    expect(key.name).toBe('ci');
    expect(token.startsWith(key.prefix)).toBe(true);
    expect(key.prefix).toHaveLength(10);

    const listed = await listApiKeys(db, project.id);
    expect(listed).toEqual([key]);
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  test('a presented key resolves to its project and role, and records when it was used', async () => {
    const { key, token } = await createApiKey(db, { projectId: project.id, name: 'reader', role: 'reader', createdBy: null });
    const auth = await authenticateApiKey(db, token);
    expect(auth?.project.slug).toBe('keyed');
    expect(auth?.key.role).toBe('reader');
    expect(auth?.key.lastUsedAt).toBeInstanceOf(Date);
    const [stored] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(stored?.lastUsedAt).toBeInstanceOf(Date);

    expect(await authenticateApiKey(db, `${token}x`)).toBeNull();
    expect(await authenticateApiKey(db, 'not-a-key')).toBeNull();
  });

  test('deleting is scoped to the project; a deleted key stops authenticating', async () => {
    const { key, token } = await createApiKey(db, { projectId: project.id, name: 'temp', role: 'editor', createdBy: null });
    expect(await deleteApiKey(db, other.id, key.id)).toBeNull();
    expect(await authenticateApiKey(db, token)).not.toBeNull();
    expect((await deleteApiKey(db, project.id, key.id))?.id).toBe(key.id);
    expect(await authenticateApiKey(db, token)).toBeNull();
  });

  test('deleting the project takes its keys along', async () => {
    const { token } = await createApiKey(db, { projectId: other.id, name: 'doomed', role: 'editor', createdBy: null });
    await db.delete(projects).where(eq(projects.id, other.id));
    expect(await authenticateApiKey(db, token)).toBeNull();
  });
});
