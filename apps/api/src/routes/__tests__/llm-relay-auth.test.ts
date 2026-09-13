/**
 * LLM relay authentication boundary tests.
 *
 * `/api/llm/*` intentionally bypasses the normal login-token middleware, so
 * the relay-key stack must independently prove both the key channel and the
 * current state of its bound internal account on every request.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClientRow } from '@greenhouse/db';

const dbMocks = vi.hoisted(() => ({
  apiClients: {
    getByKeyHash: vi.fn(),
  },
  users: {
    getById: vi.fn(),
  },
}));

// The relay's model catalog is config + env, not data — stub it so these tests
// assert the AUTH boundary rather than whatever the shipped config happens to
// declare. `catalogSpy` doubles as the "did we get past auth?" probe.
const catalogSpy = vi.hoisted(() => vi.fn());
vi.mock('../../config/models.js', () => ({
  getModelCatalog: () => {
    catalogSpy();
    return {
      models: {
        flash: { name: 'Flash', providers: [{ provider: 'deepseek', model: 'f', apiKeyEnv: 'RELAY_TEST_KEY' }] },
      },
      relay: { default: 'flash', public: ['flash'] },
    };
  },
}));

vi.mock('@greenhouse/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@greenhouse/db')>();
  return { ...actual, getDb: () => dbMocks };
});

import type { AppEnv } from '../../app-env.js';
import { authMiddleware } from '../../auth/middleware.js';
import { createLlmRelayRoutes } from '../llm-relay.js';

const RAW_KEY = `lpai_sk_${'a'.repeat(64)}`;

function makeClient(overrides: Partial<ApiClientRow> = {}): ApiClientRow {
  return {
    id: 'relay-client',
    app_id: 'relay-app',
    app_name: 'Relay App',
    api_key_hash: 'unused-in-test',
    status: 'active',
    rate_limit_rpm: 60,
    rate_limit_rpd: 1000,
    daily_token_limit: 1_000_000,
    meta: '{}',
    user_id: 'bound-user',
    channel: 'relay',
    created_by: 'admin',
    created_at: '2026-07-21T00:00:00.000Z',
    updated_at: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

function createApp() {
  return new Hono<AppEnv>().use('*', authMiddleware).route('/api/llm', createLlmRelayRoutes());
}

async function listModels() {
  return createApp().request('/api/llm/v1/models', {
    headers: { Authorization: `Bearer ${RAW_KEY}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.apiClients.getByKeyHash.mockResolvedValue(makeClient());
  process.env.RELAY_TEST_KEY = 'upstream-secret';
});

describe('LLM relay key authentication boundary', () => {
  it('still requires a relay API key even though global login auth exempts the route', async () => {
    const response = await createApp().request('/api/llm/v1/models');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: 'auth_error', message: expect.stringMatching(/Authorization header/) },
    });
    expect(dbMocks.apiClients.getByKeyHash).not.toHaveBeenCalled();
    expect(dbMocks.users.getById).not.toHaveBeenCalled();
  });

  it('rejects an active key from the wrong channel before looking up a user', async () => {
    dbMocks.apiClients.getByKeyHash.mockResolvedValue(makeClient({ channel: 'a2a' }));

    const response = await listModels();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: 'auth_error', message: 'This API key cannot access the model gateway' },
    });
    expect(dbMocks.users.getById).not.toHaveBeenCalled();
    expect(catalogSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined, 'The user bound to this key is unavailable or disabled'],
    [
      'disabled',
      { id: 'bound-user', status: 'disabled', role: 'team' },
      'The user bound to this key is unavailable or disabled',
    ],
    [
      'external',
      { id: 'bound-user', status: 'active', role: 'external' },
      'The model gateway requires an internal user',
    ],
  ])('rejects a relay key bound to a %s user', async (_label, user, message) => {
    dbMocks.users.getById.mockResolvedValue(user);

    const response = await listModels();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { type: 'auth_error', message } });
    expect(dbMocks.users.getById).toHaveBeenCalledWith('bound-user');
    expect(catalogSpy).not.toHaveBeenCalled();
  });

  it.each(['team', 'super'] as const)('allows a relay key bound to an active %s user', async (role) => {
    dbMocks.users.getById.mockResolvedValue({ id: 'bound-user', status: 'active', role });

    const response = await listModels();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      object: 'list',
      data: [{ id: 'flash', display_name: 'Flash', object: 'model', owned_by: 'greenhouse-gateway' }],
    });
    expect(dbMocks.users.getById).toHaveBeenCalledWith('bound-user');
    expect(catalogSpy).toHaveBeenCalled();
  });

  it('fails closed when the bound-user lookup throws', async () => {
    dbMocks.users.getById.mockRejectedValue(new Error('database unavailable'));

    const response = await listModels();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: 'server_error', message: 'Internal server error' },
    });
    expect(catalogSpy).not.toHaveBeenCalled();
  });
});
