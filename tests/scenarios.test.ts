import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DEFAULT_PROMPTS, DEFAULT_SCENARIOS } from '../src/core/layers/defaults';
import { seedDefaults } from '../src/core/layers/service';
import { signIn } from '../src/core/auth/service';
import { createProject, deleteProject } from '../src/core/projects/service';
import { createScenario, listScenarios, seedAllScenarios } from '../src/core/scenarios/service';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { guardRules, projects, promptVersions, prompts, scenarios, users } from '../src/db/schema';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://opendeepl:opendeepl@localhost:5432/opendeepl_test';

const { db, pool } = createDb(DATABASE_URL);
let owner: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  await runMigrations(db);
  await db.delete(projects);
  await db.delete(users);
  owner = await signIn(db, { sub: 'scenarios-owner', email: 'owner@example.com', name: 'Owner', avatarUrl: null });
});

afterAll(async () => {
  await pool.end();
});

describe('built-in prompts', () => {
  test('a body edited in code becomes the next version on the next seed; unchanged bodies add nothing', async () => {
    await seedDefaults(db);
    expect((await seedDefaults(db)).prompts).toBe(0);
    const [base] = await db.select().from(prompts).where(eq(prompts.name, 'translate/base'));
    if (!base) throw new Error('no base prompt');
    const before = await db.select().from(promptVersions).where(eq(promptVersions.promptId, base.id));
    const latest = Math.max(...before.map((version) => version.version));
    // Simulate a body that drifted from code: rewrite the latest version, seed again.
    await db.update(promptVersions).set({ body: 'stale' }).where(eq(promptVersions.promptId, base.id));
    expect((await seedDefaults(db)).prompts).toBe(1);
    const after = await db.select().from(promptVersions).where(eq(promptVersions.promptId, base.id));
    expect(Math.max(...after.map((version) => version.version))).toBe(latest + 1);
    expect(after.find((version) => version.version === latest + 1)?.body).toBe(DEFAULT_PROMPTS.find((prompt) => prompt.name === 'translate/base')?.body ?? '');
  });
});

describe('built-in scenarios', () => {
  test('every new project gets the catalog; seeding again adds nothing', async () => {
    const project = await createProject(db, { slug: 'seeded', name: 'Seeded' }, owner);
    const seeded = await listScenarios(db, project.id);
    expect(seeded.map((scenario) => scenario.name).sort()).toEqual(DEFAULT_SCENARIOS.map((scenario) => scenario.name).sort());
    expect(seeded.every((scenario) => scenario.builtin)).toBe(true);
    expect(seeded.find((scenario) => scenario.name === 'iOS release notes')?.tags).toEqual(['ios', 'ios-releases']);
    expect(await seedAllScenarios(db)).toBe(0);
  });

  test('projects created before the catalog are backfilled at boot', async () => {
    const [legacy] = await db.insert(projects).values({ slug: 'legacy', name: 'Legacy' }).returning();
    if (!legacy) throw new Error('no project');
    expect(await seedAllScenarios(db)).toBe(DEFAULT_SCENARIOS.length);
    expect(await listScenarios(db, legacy.id)).toHaveLength(DEFAULT_SCENARIOS.length);
  });

  test('deleting a project removes what was attached to its scenarios', async () => {
    const project = await createProject(db, { slug: 'doomed', name: 'Doomed' }, owner);
    const custom = await createScenario(db, project.id, { name: 'Custom', tags: ['x'] });
    await db.insert(prompts).values({ layerId: null, name: 'attached', scope: 'scenario', scopeRef: custom.id });
    await db.insert(guardRules).values({ guard: 'length-cap', scope: 'scenario', scopeRef: custom.id, params: { maxLength: 5 } });
    expect(await deleteProject(db, 'doomed')).toBe(true);
    expect(await db.select().from(scenarios).where(eq(scenarios.projectId, project.id))).toHaveLength(0);
    expect(await db.select().from(prompts).where(eq(prompts.scopeRef, custom.id))).toHaveLength(0);
    expect(await db.select().from(guardRules).where(eq(guardRules.scopeRef, custom.id))).toHaveLength(0);
    expect(await deleteProject(db, 'doomed')).toBe(false);
  });
});
