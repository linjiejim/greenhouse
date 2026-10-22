import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = vi.hoisted(() => ({
  getById: vi.fn(),
}));

// Partial mock: keep the real module's other exports (the extension seam calls
// `registerExtensionServices` at import time, so a bare object mock breaks as
// soon as a deployment enables an extension that has services).
vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  getDb: () => ({ users: { getById: dbMocks.getById } }),
}));

process.env.TOKEN_SIGNING_KEY = '44'.repeat(32);

import { createAccessToken } from '../../auth/token.js';
import { agentBearerAuthMiddleware, getAgentIdentity } from '../api-auth.js';
import type { AppEnv } from '../../app-env.js';

function createApp() {
  return new Hono<AppEnv>().use('*', agentBearerAuthMiddleware).get('/protected', (c) => c.json(getAgentIdentity(c)));
}

describe('agent bearer authentication', () => {
  beforeEach(() => {
    dbMocks.getById.mockReset();
  });

  it('binds the runtime to the active database user and current role', async () => {
    dbMocks.getById.mockResolvedValue({ id: 'user-1', status: 'active', role: 'team', auth_version: 0 });

    const response = await createApp().request('/protected', {
      headers: { Authorization: `Bearer ${createAccessToken('user-1', 'super', 0)}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ userId: 'user-1', userRole: 'team' });
  });

  it('rejects the removed synthetic internal identity', async () => {
    dbMocks.getById.mockResolvedValue(undefined);

    const response = await createApp().request('/protected', {
      headers: { Authorization: `Bearer ${createAccessToken('internal', 'super', 0)}` },
    });

    expect(response.status).toBe(403);
    expect(dbMocks.getById).toHaveBeenCalledWith('internal');
  });

  it('rejects a legacy database role outside team and super', async () => {
    dbMocks.getById.mockResolvedValue({ id: 'legacy-user', status: 'active', role: 'member', auth_version: 0 });

    const response = await createApp().request('/protected', {
      headers: { Authorization: `Bearer ${createAccessToken('legacy-user', 'team', 0)}` },
    });

    expect(response.status).toBe(403);
  });

  it('rejects an access token from an older credential version', async () => {
    dbMocks.getById.mockResolvedValue({ id: 'user-1', status: 'active', role: 'team', auth_version: 3 });

    const response = await createApp().request('/protected', {
      headers: { Authorization: `Bearer ${createAccessToken('user-1', 'team', 2)}` },
    });

    expect(response.status).toBe(401);
  });

  it('rejects a retired Mission task token like any other invalid bearer', async () => {
    const response = await createApp().request('/protected', {
      headers: { Authorization: 'Bearer lpct_eyJ1aWQiOiJ1c2VyLTEifQ.c2ln' },
    });

    expect(response.status).toBe(401);
    expect(dbMocks.getById).not.toHaveBeenCalled();
  });
});
