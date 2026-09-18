import { describe, expect, test } from 'bun:test';
import { clearSessionCookie, hashToken, newToken, safeNext, SESSION_COOKIE, sessionCookie } from '../src/core/auth/session';
import { hasRole } from '../src/core/members/roles';

describe('session tokens', () => {
  test('tokens are long, unique and hashed deterministically', () => {
    const a = newToken();
    const b = newToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(hashToken(b));
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('session cookie is httpOnly, lax and only secure in production', () => {
    const dev = sessionCookie('abc', { secure: false });
    expect(dev).toContain(`${SESSION_COOKIE}=abc`);
    expect(dev).toContain('HttpOnly');
    expect(dev).toContain('SameSite=Lax');
    expect(dev).toContain('Path=/');
    expect(dev).not.toContain('Secure');
    expect(sessionCookie('abc', { secure: true })).toContain('Secure');
    expect(clearSessionCookie({ secure: false })).toContain('Max-Age=0');
  });
});

describe('safeNext', () => {
  test('keeps same-origin paths and rejects everything else', () => {
    expect(safeNext('/projects/ios?tag=x')).toBe('/projects/ios?tag=x');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(null)).toBe('/');
    expect(safeNext('')).toBe('/');
  });
});

describe('roles', () => {
  test('rank order is reader < editor < admin', () => {
    expect(hasRole('admin', 'reader')).toBe(true);
    expect(hasRole('editor', 'editor')).toBe(true);
    expect(hasRole('reader', 'editor')).toBe(false);
    expect(hasRole('editor', 'admin')).toBe(false);
  });
});
