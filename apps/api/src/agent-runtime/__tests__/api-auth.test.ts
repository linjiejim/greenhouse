import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getRunById: vi.fn(),
}));

// Partial mock: keep the real module's other exports (the extension seam calls
// `registerExtensionServices` at import time, so a bare object mock breaks as
// soon as a deployment enables an extension that has services).
vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  getDb: () => ({ users: { getById: dbMocks.getById }, agentRuns: { getRunById: dbMocks.getRunById } }),
}));

process.env.TOKEN_SIGNING_KEY = '44'.repeat(32);

import { createAccessToken } from '../../auth/token.js';
import { createTaskToken } from '../../auth/task-token.js';
import { agentBearerAuthMiddleware, getAgentIdentity } from '../api-auth.js';
import { _setCloudAgentController } from '../../cloud-agent/index.js';
import type { AppEnv } from '../../app-env.js';

function createApp() {
  return new Hono<AppEnv>().use('*', agentBearerAuthMiddleware).get('/protected', (c) => c.json(getAgentIdentity(c)));
}

describe('agent bearer authentication', () => {
  beforeEach(() => {
    dbMocks.getById.mockReset();
    dbMocks.getRunById.mockReset();
    _setCloudAgentController(null);
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

  it('closes task-token tool access when Mission admission is unavailable', async () => {
    const response = await createApp().request('/protected', {
      headers: { Authorization: `Bearer ${createTaskToken('user-1', 'car_1', 60_000)}` },
    });

    expect(response.status).toBe(503);
    expect(dbMocks.getById).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'mission_runtime_unavailable' },
    });
  });

  it('still accepts an ordinary user bearer while Mission admission is unavailable', async () => {
    dbMocks.getById.mockResolvedValue({ id: 'user-1', status: 'active', role: 'team', auth_version: 0 });

    const response = await createApp().request('/protected', {
      headers: { Authorization: `Bearer ${createAccessToken('user-1', 'team', 0)}` },
    });

    expect(response.status).toBe(200);
  });

  it('accepts a task token only when Mission and its bound run are active', async () => {
    _setCloudAgentController({} as never);
    dbMocks.getById.mockResolvedValue({ id: 'user-1', status: 'active', role: 'team', auth_version: 0 });
    dbMocks.getRunById.mockResolvedValue({ id: 'car_1', user_id: 'user-1', status: 'running' });

    const response = await createApp().request('/protected', {
      headers: { Authorization: `Bearer ${createTaskToken('user-1', 'car_1', 60_000)}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ credential: 'task', runId: 'car_1' });
  });
});
