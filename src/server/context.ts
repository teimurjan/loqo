import type { BunRequest } from 'bun';
import type { ResolvedConfig } from '../config';
import { type ApiKeyPublic, authenticateApiKey } from '../core/api-keys/service';
import type { GoogleAuth } from '../core/auth/google';
import { getSession, SESSION_COOKIE, sessionCookie } from '../core/auth/session';
import type { Pricing } from '../core/pricing';
import type { TranslateQueue } from '../core/queue/types';
import type { Db } from '../db/client';
import type { Project, User } from '../db/schema';
import { errorResponse, HttpError } from './http';

export type AppContext = {
  db: Db;
  queue: TranslateQueue;
  config: ResolvedConfig;
  pricing: Pricing;
  auth: GoogleAuth;
  /** `Secure` cookies — off only for plain-http local development. */
  secureCookies: boolean;
};

/** Who is calling: a signed-in user, or a repo's sync step holding one project's API key. */
export type Principal = { kind: 'user'; user: User; sessionId: string } | { kind: 'key'; key: ApiKeyPublic; project: Project };

export type RequestContext = AppContext & { principal: Principal };

export type Handler<Path extends string> = (req: BunRequest<Path>, ctx: RequestContext) => Promise<Response> | Response;

const bearerOf = (headers: Headers): string | null => {
  const header = headers.get('authorization') ?? '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return headers.get('x-api-key');
};

type Authenticated = { principal: Principal; renewCookie: string | null };

const authenticate = async (ctx: AppContext, req: Pick<BunRequest, 'headers' | 'cookies'>): Promise<Authenticated> => {
  const presented = bearerOf(req.headers);
  if (presented !== null) {
    const auth = await authenticateApiKey(ctx.db, presented);
    if (!auth) throw new HttpError(401, 'Unauthorized');
    return { principal: { kind: 'key', ...auth }, renewCookie: null };
  }
  const token = req.cookies.get(SESSION_COOKIE);
  const session = token ? await getSession(ctx.db, token) : null;
  if (!token || !session) throw new HttpError(401, 'Unauthorized');
  return {
    principal: { kind: 'user', user: session.user, sessionId: session.session.id },
    // A renewed session is only useful if the browser's cookie slides with it.
    renewCookie: session.renewed ? sessionCookie(token, { secure: ctx.secureCookies }) : null,
  };
};

/** Every API route goes through here: auth first, then error → HTTP mapping. Nothing else. */
export const route =
  (ctx: AppContext) =>
  <Path extends string>(handler: Handler<Path>) =>
  async (req: BunRequest<Path>): Promise<Response> => {
    try {
      const { principal, renewCookie } = await authenticate(ctx, req);
      const response = await handler(req, { ...ctx, principal });
      if (renewCookie) response.headers.append('set-cookie', renewCookie);
      return response;
    } catch (error) {
      return errorResponse(error);
    }
  };

/** The few routes a browser reaches before it has a session: health and the sign-in dance. */
export const openRoute =
  (ctx: AppContext) =>
  <Path extends string>(handler: (req: BunRequest<Path>, ctx: AppContext) => Promise<Response> | Response) =>
  async (req: BunRequest<Path>): Promise<Response> => {
    try {
      return await handler(req, ctx);
    } catch (error) {
      return errorResponse(error);
    }
  };

/** Who did it, for the audit log. */
export const actorOf = (ctx: RequestContext): string => (ctx.principal.kind === 'key' ? `key:${ctx.principal.key.name}` : ctx.principal.user.email);

/** Routes only a person may take — creating projects, minting keys — never a key, however privileged. */
export const requireUser = (ctx: RequestContext): User => {
  if (ctx.principal.kind !== 'user') throw new HttpError(403, 'Sign in to do this; an API key cannot');
  return ctx.principal.user;
};
