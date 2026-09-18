import { ArcticFetchError, decodeIdToken, generateCodeVerifier, generateState, Google, OAuth2RequestError } from 'arctic';

export type GoogleProfile = { sub: string; email: string; name: string; avatarUrl: string | null };

export type GoogleExchange = { ok: true; profile: GoogleProfile } | { ok: false; reason: string };

export type GoogleAuth = {
  /** Where to send the browser; `state` and `verifier` must come back in the callback. */
  begin: () => { url: URL; state: string; verifier: string };
  exchange: (code: string, verifier: string) => Promise<GoogleExchange>;
};

const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

type IdClaims = { iss?: unknown; aud?: unknown; exp?: unknown; sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown; picture?: unknown };

/**
 * The ID token comes straight from Google's token endpoint over TLS, authenticated with the client
 * secret, so a signature check adds nothing; the claims still have to say what we expect.
 */
const profileOf = (claims: IdClaims, clientId: string): GoogleExchange => {
  if (typeof claims.iss !== 'string' || !ISSUERS.has(claims.iss)) return { ok: false, reason: 'unexpected issuer' };
  if (claims.aud !== clientId) return { ok: false, reason: 'token is for another client' };
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return { ok: false, reason: 'token expired' };
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') return { ok: false, reason: 'token has no identity' };
  if (claims.email_verified !== true) return { ok: false, reason: 'email is not verified' };
  return {
    ok: true,
    profile: {
      sub: claims.sub,
      email: claims.email.toLowerCase(),
      name: typeof claims.name === 'string' && claims.name.trim() ? claims.name : claims.email,
      avatarUrl: typeof claims.picture === 'string' ? claims.picture : null,
    },
  };
};

export const createGoogleAuth = (env: { clientId: string; clientSecret: string; appUrl: string }): GoogleAuth => {
  const google = new Google(env.clientId, env.clientSecret, `${env.appUrl.replace(/\/$/, '')}/api/auth/google/callback`);
  return {
    begin: () => {
      const state = generateState();
      const verifier = generateCodeVerifier();
      return { url: google.createAuthorizationURL(state, verifier, ['openid', 'email', 'profile']), state, verifier };
    },
    exchange: async (code, verifier) => {
      try {
        const tokens = await google.validateAuthorizationCode(code, verifier);
        return profileOf(decodeIdToken(tokens.idToken()) as IdClaims, env.clientId);
      } catch (error) {
        if (error instanceof OAuth2RequestError) return { ok: false, reason: `google rejected the code (${error.code})` };
        if (error instanceof ArcticFetchError) return { ok: false, reason: 'could not reach google' };
        return { ok: false, reason: error instanceof Error ? error.message : 'sign-in failed' };
      }
    },
  };
};
