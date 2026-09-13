import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  getDb: () => ({
    users: { getById: dbMocks.getById },
    accountPasswordLinks: { inspect: vi.fn().mockResolvedValue(null), complete: vi.fn().mockResolvedValue(null) },
  }),
  isDbInitialized: () => false,
}));

process.env.TOKEN_SIGNING_KEY = '33'.repeat(32);

import { authMiddleware } from '../middleware.js';
import { createAccessToken } from '../token.js';
import authRoutes from '../../routes/auth.js';
import type { AppEnv } from '../../app-env.js';

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function createProtectedApp() {
  return new Hono<AppEnv>()
    .use('*', authMiddleware)
    .route('/api/auth', authRoutes)
    .get('/protected', (c) => c.json({ user: c.get('user') }))
    .post('/api/v1/chat/completions', (c) => c.json({ shouldNeverBePublic: true }));
}

describe('internal-only authentication boundary', () => {
  beforeEach(() => {
    dbMocks.getById.mockReset();
  });

  it('accepts an existing active internal user and uses the current database role', async () => {
    dbMocks.getById.mockResolvedValue({ id: 'team-user', status: 'active', role: 'team', auth_version: 0 });
    const app = createProtectedApp();
    const response = await app.request('/protected', { headers: bearer(createAccessToken('team-user', 'team', 0)) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ user: { id: 'team-user', role: 'team' } });
  });

  it('rejects a historical external access token before any database lookup', async () => {
    const app = createProtectedApp();
    const response = await app.request('/protected', {
      headers: bearer(createAccessToken('external', 'external', 0)),
    });

    expect(response.status).toBe(403);
    expect(dbMocks.getById).not.toHaveBeenCalled();
  });

  it('rejects deleted, disabled, and no-longer-internal accounts', async () => {
    const app = createProtectedApp();
    const token = createAccessToken('former-user', 'team', 0);

    dbMocks.getById.mockResolvedValueOnce(undefined);
    expect((await app.request('/protected', { headers: bearer(token) })).status).toBe(401);

    dbMocks.getById.mockResolvedValueOnce({ id: 'former-user', status: 'disabled', role: 'team', auth_version: 0 });
    expect((await app.request('/protected', { headers: bearer(token) })).status).toBe(401);

    dbMocks.getById.mockResolvedValueOnce({ id: 'former-user', status: 'active', role: 'external', auth_version: 0 });
    expect((await app.request('/protected', { headers: bearer(token) })).status).toBe(403);
  });

  it('does not expose the removed external-login route', async () => {
    const app = createProtectedApp();
    dbMocks.getById.mockResolvedValue({ id: 'team-user', status: 'active', role: 'team', auth_version: 0 });
    const token = createAccessToken('team-user', 'team', 0);
    const response = await app.request('/api/auth/login/external', { method: 'POST', headers: bearer(token) });

    expect(response.status).toBe(404);
  });

  it('rejects the removed synthetic internal identity when no real user row exists', async () => {
    dbMocks.getById.mockResolvedValue(undefined);
    const app = createProtectedApp();
    const response = await app.request('/protected', {
      headers: bearer(createAccessToken('internal', 'super', 0)),
    });

    expect(response.status).toBe(401);
    expect(dbMocks.getById).toHaveBeenCalledWith('internal');
  });

  it('no longer treats /api/v1 as an authentication-exempt surface', async () => {
    const app = createProtectedApp();
    const response = await app.request('/api/v1/chat/completions', { method: 'POST' });

    expect(response.status).toBe(401);
  });

  it('exempts only the two exact password-link POST paths', async () => {
    const app = createProtectedApp();
    expect((await app.request('/api/auth/password-link/inspect', { method: 'POST' })).status).not.toBe(401);
    expect((await app.request('/api/auth/password-link/complete', { method: 'POST' })).status).not.toBe(401);
    expect((await app.request('/api/auth/password-link/inspect/extra', { method: 'POST' })).status).toBe(401);
  });

  it('rejects an access token issued before the account credential version changed', async () => {
    dbMocks.getById.mockResolvedValue({ id: 'team-user', status: 'active', role: 'team', auth_version: 2 });
    const response = await createProtectedApp().request('/protected', {
      headers: bearer(createAccessToken('team-user', 'team', 1)),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ needsAuth: true });
  });
});
