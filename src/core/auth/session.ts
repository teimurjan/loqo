import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { type Session, type User, sessions, users } from '../../db/schema';

export const SESSION_COOKIE = 'loqo_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding window: a session used with less than this left gets a fresh 30 days. */
const RENEW_BELOW_MS = 15 * 24 * 60 * 60 * 1000;

export const newToken = (): string => randomBytes(32).toString('base64url');

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export type SessionAuth = { user: User; session: Session; renewed: boolean };

export const createSession = async (db: Db, userId: string): Promise<{ token: string; session: Session }> => {
  const token = newToken();
  const [session] = await db
    .insert(sessions)
    .values({ tokenHash: hashToken(token), userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
    .returning();
  if (!session) throw new Error('insert returned no row');
  return { token, session };
};

export const getSession = async (db: Db, token: string): Promise<SessionAuth | null> => {
  const [row] = await db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;
  const renewed = row.session.expiresAt.getTime() - Date.now() < RENEW_BELOW_MS;
  if (!renewed) return { ...row, renewed };
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, row.session.id));
  return { user: row.user, session: { ...row.session, expiresAt }, renewed };
};

export const deleteSession = async (db: Db, id: string): Promise<void> => {
  await db.delete(sessions).where(eq(sessions.id, id));
};

type CookieOptions = { secure: boolean; maxAge?: number };

const cookie = (name: string, value: string, { secure, maxAge }: CookieOptions): string =>
  Bun.Cookie.from(name, value, { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge }).serialize();

export const sessionCookie = (token: string, options: { secure: boolean }): string =>
  cookie(SESSION_COOKIE, token, { ...options, maxAge: SESSION_TTL_MS / 1000 });

export const clearSessionCookie = (options: { secure: boolean }): string => cookie(SESSION_COOKIE, '', { ...options, maxAge: 0 });

/** Short-lived cookies that carry OAuth state across the redirect to Google and back. */
export const transientCookie = (name: string, value: string, options: { secure: boolean }): string =>
  cookie(name, value, { ...options, maxAge: 600 });

export const clearCookie = (name: string, options: { secure: boolean }): string => cookie(name, '', { ...options, maxAge: 0 });

/** Only same-origin paths may be used as a post-login redirect. */
export const safeNext = (value: string | null | undefined): string =>
  value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
