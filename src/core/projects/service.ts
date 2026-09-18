import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { type GlossaryEntry, type Project, type User, projectMembers, projects, resources, scenarios, targets } from '../../db/schema';
import { deleteScenarioScoped, seedScenarios } from '../scenarios/service';

export type ProjectInput = {
  slug: string;
  name: string;
  sourceLocale?: string;
  targetLocales?: string[];
  glossary?: GlossaryEntry[];
  extraInstructions?: Record<string, string>;
  debounceSeconds?: number;
};

export type ProjectCounts = { resources: number; targets: Record<string, number> };

export type ProjectWithCounts = Project & { counts: ProjectCounts };

const countsFor = async (db: Db, projectIds: string[]): Promise<Map<string, ProjectCounts>> => {
  const counts = new Map<string, ProjectCounts>();
  if (projectIds.length === 0) return counts;
  const [resourceRows, targetRows] = await Promise.all([
    db
      .select({ projectId: resources.projectId, total: sql<number>`count(*)::int` })
      .from(resources)
      .where(inArray(resources.projectId, projectIds))
      .groupBy(resources.projectId),
    db
      .select({ projectId: resources.projectId, status: targets.status, total: sql<number>`count(*)::int` })
      .from(targets)
      .innerJoin(resources, eq(resources.id, targets.resourceId))
      .where(inArray(resources.projectId, projectIds))
      .groupBy(resources.projectId, targets.status),
  ]);
  for (const id of projectIds) counts.set(id, { resources: 0, targets: {} });
  for (const row of resourceRows) {
    const entry = counts.get(row.projectId);
    if (entry) entry.resources = row.total;
  }
  for (const row of targetRows) {
    const entry = counts.get(row.projectId);
    if (entry) entry.targets[row.status] = row.total;
  }
  return counts;
};

export const listProjects = async (db: Db, filter: { projectIds?: string[] } = {}): Promise<ProjectWithCounts[]> => {
  if (filter.projectIds?.length === 0) return [];
  const rows = await db
    .select()
    .from(projects)
    .where(filter.projectIds ? inArray(projects.id, filter.projectIds) : undefined)
    .orderBy(asc(projects.name));
  const counts = await countsFor(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...row, counts: counts.get(row.id) ?? { resources: 0, targets: {} } }));
};

export const getProjectById = async (db: Db, id: string): Promise<Project | null> => {
  const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return row ?? null;
};

export const getProject = async (db: Db, slug: string): Promise<ProjectWithCounts | null> => {
  const [row] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  if (!row) return null;
  const counts = await countsFor(db, [row.id]);
  return { ...row, counts: counts.get(row.id) ?? { resources: 0, targets: {} } };
};

/** The creator becomes the project's first admin. */
export const createProject = (db: Db, input: ProjectInput, owner: Pick<User, 'id' | 'email'>): Promise<Project> =>
  db.transaction(async (tx) => {
    const [row] = await tx.insert(projects).values(input).returning();
    if (!row) throw new Error('insert returned no row');
    await tx.insert(projectMembers).values({ projectId: row.id, userId: owner.id, email: owner.email, role: 'admin', acceptedAt: new Date() });
    await seedScenarios(tx, row.id);
    return row;
  });

export const updateProject = async (db: Db, slug: string, input: Partial<ProjectInput>): Promise<Project | null> => {
  const [row] = await db
    .update(projects)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(projects.slug, slug))
    .returning();
  return row ?? null;
};

/** Scenario attachments do not cascade through a foreign key, so they are removed here first. */
export const deleteProject = (db: Db, slug: string): Promise<boolean> =>
  db.transaction(async (tx) => {
    const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).limit(1);
    if (!project) return false;
    const owned = await tx.select({ id: scenarios.id }).from(scenarios).where(eq(scenarios.projectId, project.id));
    await deleteScenarioScoped(
      tx,
      owned.map((row) => row.id),
    );
    await tx.delete(projects).where(eq(projects.id, project.id));
    return true;
  });
