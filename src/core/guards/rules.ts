import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { type GuardRule, type PromptScope, guardRules } from '../../db/schema';

export type GuardRuleInput = { guard: string; params: Record<string, unknown>; enabled: boolean };

export const getGuardRule = async (db: Db, id: string): Promise<GuardRule | null> => {
  const [row] = await db.select().from(guardRules).where(eq(guardRules.id, id)).limit(1);
  return row ?? null;
};

/** One rule per guard and scope: attaching the same guard twice updates its parameters. */
export const upsertGuardRule = async (db: Db, input: GuardRuleInput & { scope: PromptScope; scopeRef: string }): Promise<GuardRule> => {
  const [row] = await db
    .insert(guardRules)
    .values(input)
    .onConflictDoUpdate({ target: [guardRules.guard, guardRules.scope, guardRules.scopeRef], set: { params: input.params, enabled: input.enabled, updatedAt: new Date() } })
    .returning();
  if (!row) throw new Error('upsert returned no row');
  return row;
};

export const updateGuardRule = async (db: Db, id: string, input: Partial<Omit<GuardRuleInput, 'guard'>>): Promise<GuardRule | null> => {
  const [row] = await db
    .update(guardRules)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(guardRules.id, id))
    .returning();
  return row ?? null;
};

export const deleteGuardRule = async (db: Db, id: string): Promise<boolean> =>
  (await db.delete(guardRules).where(eq(guardRules.id, id)).returning({ id: guardRules.id })).length > 0;
