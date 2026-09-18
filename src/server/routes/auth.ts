import { z } from 'zod';
import { recordAudit } from '../../core/audit/service';
import { signIn } from '../../core/auth/service';
import { clearCookie, clearSessionCookie, createSession, deleteSession, safeNext, sessionCookie, transientCookie } from '../../core/auth/session';
import { memberships } from '../../core/members/service';
import { type AppContext, actorOf, openRoute, route } from '../context';
import { json, parseQuery } from '../http';

const STATE_COOKIE = 'opendeepl_oauth_state';
const VERIFIER_COOKIE = 'opendeepl_oauth_verifier';
const NEXT_COOKIE = 'opendeepl_oauth_next';

const redirect = (location: string, cookies: string[]): Response => {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
};

export const authRoutes = (ctx: AppContext) => {
  const r = route(ctx);
  const open = openRoute(ctx);
  const cookies = { secure: ctx.secureCookies };
  const failed = (reason: string) =>
    redirect(`/login?error=${encodeURIComponent(reason)}`, [clearCookie(STATE_COOKIE, cookies), clearCookie(VERIFIER_COOKIE, cookies), clearCookie(NEXT_COOKIE, cookies)]);

  return {
    '/api/auth/google': {
      GET: open(async (req) => {
        const { next } = parseQuery(req, z.object({ next: z.string().optional() }));
        const { url, state, verifier } = ctx.auth.begin();
        return redirect(url.toString(), [
          transientCookie(STATE_COOKIE, state, cookies),
          transientCookie(VERIFIER_COOKIE, verifier, cookies),
          transientCookie(NEXT_COOKIE, safeNext(next), cookies),
        ]);
      }),
    },
    '/api/auth/google/callback': {
      GET: open(async (req) => {
        const query = parseQuery(req, z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }));
        if (query.error) return failed(query.error);
        const expectedState = req.cookies.get(STATE_COOKIE);
        const verifier = req.cookies.get(VERIFIER_COOKIE);
        if (!query.code || !query.state || !expectedState || !verifier || query.state !== expectedState) return failed('sign-in expired, try again');
        const exchange = await ctx.auth.exchange(query.code, verifier);
        if (!exchange.ok) return failed(exchange.reason);
        const user = await signIn(ctx.db, exchange.profile);
        const { token } = await createSession(ctx.db, user.id);
        await recordAudit(ctx.db, { actor: user.email, action: 'auth.login', detail: {} });
        return redirect(safeNext(req.cookies.get(NEXT_COOKIE)), [
          sessionCookie(token, cookies),
          clearCookie(STATE_COOKIE, cookies),
          clearCookie(VERIFIER_COOKIE, cookies),
          clearCookie(NEXT_COOKIE, cookies),
        ]);
      }),
    },
    '/api/auth/me': {
      GET: r(async (_req, rc) => {
        if (rc.principal.kind === 'key') {
          const { key, project } = rc.principal;
          return json({ user: null, api: true, memberships: [{ projectId: project.id, projectSlug: project.slug, role: key.role }] });
        }
        const { user } = rc.principal;
        return json({
          user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl },
          api: false,
          memberships: await memberships(rc.db, user.id),
        });
      }),
    },
    '/api/auth/logout': {
      POST: r(async (_req, rc) => {
        if (rc.principal.kind === 'user') {
          await deleteSession(rc.db, rc.principal.sessionId);
          await recordAudit(rc.db, { actor: actorOf(rc), action: 'auth.logout', detail: {} });
        }
        const response = json({ ok: true });
        response.headers.set('set-cookie', clearSessionCookie(cookies));
        return response;
      }),
    },
  };
};
