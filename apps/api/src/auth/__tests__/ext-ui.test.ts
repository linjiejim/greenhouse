import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createAccessToken, createExtUiToken, validateAccessToken, validateExtUiToken } from '../token.js';
import { authMiddleware } from '../middleware.js';
import extUiRoutes from '../../routes/ext-ui.js';
import meRoutes from '../../routes/me.js';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  user: { id: 'alice', nickname: 'Alice', role: 'team', auth_version: 2, status: 'active' },
  allowed: true,
}));
vi.mock('@greenhouse/db', () => ({
  getDb: () => ({ users: { getById: async (id: string) => (id === mocks.user.id ? mocks.user : null) } }),
}));
vi.mock('../../extensions/ui-access.js', () => ({
  memberCanUsePlugin: async (_db: unknown, _user: unknown, plugin: string) => mocks.allowed && plugin === 'example',
}));
const app = new Hono<AppEnv>()
  .use('*', authMiddleware)
  .route('/api/ext-ui', extUiRoutes)
  .route('/api/me', meRoutes)
  .all('/api/ext/:plugin/*', (c) => c.json({ user: c.get('user') }))
  .all('/api/admin/users', (c) => c.json({ escaped: true }));
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
beforeEach(() => {
  vi.stubEnv('TOKEN_SIGNING_KEY', '88'.repeat(32));
  mocks.allowed = true;
  mocks.user.status = 'active';
  mocks.user.auth_version = 2;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const token = () => createExtUiToken('alice', 'team', 2, 'example');

it('mints a ten-minute, purpose-separated token and renews it only through the member session', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-27T00:00:00Z'));
  const response = await app.request('/api/ext-ui/token', {
    method: 'POST',
    headers: bearer(createAccessToken('alice', 'team', 2)),
    body: JSON.stringify({ plugin: 'example', uid: 'bob' }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const minted = await response.json();
  expect(minted.expires_at).toBe('2026-10-27T00:10:00.000Z');
  expect(validateAccessToken(minted.token)).toBeNull();
  expect(validateExtUiToken(minted.token)?.uid).toBe('alice');
  expect(
    (
      await app.request('/api/ext-ui/token', {
        method: 'POST',
        headers: bearer(minted.token),
        body: '{"plugin":"example"}',
      })
    ).status,
  ).toBe(403);
  vi.advanceTimersByTime(60_000);
  expect(token().token).not.toBe(minted.token);
});
it('allows own plugin API operations and only the basic me read', async () => {
  const headers = bearer(token().token);
  expect((await app.request('/api/ext/example/notes', { headers, method: 'POST' })).status).toBe(200);
  const me = await app.request('/api/me', { headers });
  expect(await me.json()).toEqual({ user: { id: 'alice', name: 'Alice', role: 'team' } });
  for (const [path, method] of [
    ['/api/ext/other/notes', 'GET'],
    ['/api/ext/example-other/notes', 'GET'],
    ['/api/admin/users', 'GET'],
    ['/api/me', 'PATCH'],
    ['/api/me/preferences', 'GET'],
    ['/api/auth/me', 'GET'],
    ['/api/bootstrap', 'GET'],
    ['/api/ext/example/%2f..%2fother/notes', 'GET'],
  ])
    expect((await app.request(path, { headers, method })).status, `${method} ${path}`).toBe(403);
});
it('refuses expired, tampered, wrong-member, revoked, disabled and newly denied credentials', async () => {
  vi.useFakeTimers();
  const current = token();
  vi.advanceTimersByTime(600_000);
  expect((await app.request('/api/ext/example/notes', { headers: bearer(current.token) })).status).toBe(401);
  vi.useRealTimers();
  const [data, sig] = token().token.split('.');
  const claims = JSON.parse(Buffer.from(data, 'base64url').toString());
  claims.uid = 'bob';
  for (const credential of [
    Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + sig,
    createExtUiToken('bob', 'team', 2, 'example').token,
  ])
    expect((await app.request('/api/ext/example/notes', { headers: bearer(credential) })).status).toBe(401);
  const signed = token().token;
  mocks.user.auth_version = 3;
  expect((await app.request('/api/ext/example/notes', { headers: bearer(signed) })).status).toBe(401);
  mocks.user.auth_version = 2;
  mocks.user.status = 'disabled';
  expect((await app.request('/api/ext/example/notes', { headers: bearer(signed) })).status).toBe(401);
  mocks.user.status = 'active';
  mocks.allowed = false;
  expect((await app.request('/api/ext/example/notes', { headers: bearer(signed) })).status).toBe(403);
});
it('refuses unknown or inaccessible plugins and malformed input at issuance', async () => {
  const headers = bearer(createAccessToken('alice', 'team', 2));
  for (const plugin of ['other', 'disabled'])
    expect(
      (await app.request('/api/ext-ui/token', { method: 'POST', headers, body: JSON.stringify({ plugin }) })).status,
    ).toBe(403);
  expect((await app.request('/api/ext-ui/token', { method: 'POST', headers, body: 'not json' })).status).toBe(400);
  mocks.allowed = false;
  expect(
    (await app.request('/api/ext-ui/token', { method: 'POST', headers, body: '{"plugin":"example"}' })).status,
  ).toBe(403);
});
