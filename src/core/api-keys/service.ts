import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { type ApiKey, type MemberRole, type Project, apiKeys, projects } from '../../db/schema';
import { hashToken, newToken } from '../auth/session';

const KEY_PREFIX = 'odl_';
/** `odl_` plus this many characters is what the list shows. */
const VISIBLE_CHARS = 6;
/** `lastUsedAt` is informational; a busy CI job should not turn every request into a write. */
const LAST_USED_RESOLUTION_MS = 60_000;

export type ApiKeyPublic = Omit<ApiKey, 'keyHash'>;

export type CreateApiKeyInput = { projectId: string; name: string; role: MemberRole; createdBy: string | null };

const publicOf = ({ keyHash: _hash, ...key }: ApiKey): ApiKeyPublic => key;

/** The key is returned exactly once, here; only its hash is stored. */
export const createApiKey = async (db: Db, input: CreateApiKeyInput): Promise<{ key: ApiKeyPublic; token: string }> => {
  const token = `${KEY_PREFIX}${newToken()}`;
  const [row] = await db
    .insert(apiKeys)
    .values({ ...input, name: input.name.trim(), keyHash: hashToken(token), prefix: token.slice(0, KEY_PREFIX.length + VISIBLE_CHARS) })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return { key: publicOf(row), token };
};

export const listApiKeys = async (db: Db, projectId: string): Promise<ApiKeyPublic[]> => {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.projectId, projectId)).orderBy(asc(apiKeys.createdAt));
  return rows.map(publicOf);
};

export const deleteApiKey = async (db: Db, projectId: string, id: string): Promise<ApiKeyPublic | null> => {
  const [row] = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.projectId, projectId)))
    .returning();
  return row ? publicOf(row) : null;
};

export type ApiKeyAuth = { key: ApiKeyPublic; project: Project };

/** Resolves a presented key to its project; unknown keys and keys of deleted projects are both `null`. */
export const authenticateApiKey = async (db: Db, token: string): Promise<ApiKeyAuth | null> => {
  if (!token.startsWith(KEY_PREFIX)) return null;
  const [row] = await db
    .select({ key: apiKeys, project: projects })
    .from(apiKeys)
    .innerJoin(projects, eq(projects.id, apiKeys.projectId))
    .where(eq(apiKeys.keyHash, hashToken(token)))
    .limit(1);
  if (!row) return null;
  const now = new Date();
  const stale = row.key.lastUsedAt === null || now.getTime() - row.key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS;
  if (stale) await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.key.id));
  return { key: publicOf({ ...row.key, lastUsedAt: stale ? now : row.key.lastUsedAt }), project: row.project };
};
