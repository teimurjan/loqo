import { desc, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { type AuditEntry, auditLog } from '../../db/schema';

export type AuditInput = {
  actor: string;
  action: string;
  projectId?: string | null;
  resourceId?: string | null;
  targetId?: string | null;
  detail?: Record<string, unknown>;
};

export const recordAudit = async (db: Db, input: AuditInput): Promise<void> => {
  await db.insert(auditLog).values({ ...input, detail: input.detail ?? {} });
};

export const listAudit = (db: Db, options: { limit: number; projectIds?: string[] }): Promise<AuditEntry[]> =>
  db
    .select()
    .from(auditLog)
    .where(options.projectIds ? inArray(auditLog.projectId, options.projectIds) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(options.limit);
