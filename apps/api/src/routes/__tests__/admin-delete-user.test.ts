/**
 * DELETE /api/admin/users/:id must not depend on the Bots computer host: a
 * Docker daemon that is down (or a volume still busy) is logged and left to
 * reconcile, the account is deleted anyway and never left half suspended.
 * The member's Bots conversations leave with them. Switching the `bots`
 * feature off stops their Bots runs and their computer.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  users: { getById: vi.fn(), delete: vi.fn() },
  userFeatures: { upsert: vi.fn() },
  suspend: vi.fn(),
  purge: vi.fn(),
  purgeConversations: vi.fn(),
  stopBotsRuns: vi.fn(),
}));

vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  getDb: () => ({ users: mocks.users, userFeatures: mocks.userFeatures }),
}));

vi.mock('../../security/account.js', () => ({
  getPasswordLinkCapability: () => ({ available: true }),
  deliverAccountPasswordLink: vi.fn(),
  recordAccountSecurityAudit: vi.fn(),
  suspendUserRuntime: mocks.suspend,
  resumeUserRuntime: vi.fn(),
}));

vi.mock('../../bots/computer/index.js', () => ({ purgeUserComputer: mocks.purge }));
vi.mock('../../bots/purge.js', () => ({ purgeBotsConversations: mocks.purgeConversations }));
vi.mock('../../bots/engine/run-slot.js', () => ({ stopBotsRunsForUser: mocks.stopBotsRuns }));

const { default: adminRoutes } = await import('../admin.js');

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'super-user', role: 'super' });
    return next();
  });
  app.route('/api/admin', adminRoutes);
  return app;
}

const member = { id: 'user-1', email: 'leaver@example.com', role: 'team', status: 'active' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.users.getById.mockResolvedValue(member);
  mocks.users.delete.mockResolvedValue(true);
  mocks.suspend.mockResolvedValue(undefined);
  mocks.purge.mockResolvedValue(undefined);
  mocks.purgeConversations.mockResolvedValue({ deleted: 2, deferred: 0 });
  mocks.stopBotsRuns.mockResolvedValue(1);
  mocks.userFeatures.upsert.mockImplementation(async (input: Record<string, unknown>) => input);
});

describe('admin user deletion and the Bots computer', () => {
  it('wipes the computer with its home volume, then deletes the account', async () => {
    const response = await createApp().request('/api/admin/users/user-1', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.suspend).toHaveBeenCalledWith('user-1');
    expect(mocks.purge).toHaveBeenCalledWith('user-1', { wipe: true, reason: 'admin' });
    expect(mocks.users.delete).toHaveBeenCalledWith('user-1');
  });

  it('still deletes the account when the Docker host is down', async () => {
    mocks.purge.mockRejectedValue(new Error('docker_unreachable: Cannot connect to the Docker daemon'));
    const response = await createApp().request('/api/admin/users/user-1', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.suspend).toHaveBeenCalledWith('user-1');
    expect(mocks.users.delete).toHaveBeenCalledWith('user-1');
    expect(mocks.purgeConversations).toHaveBeenCalledWith('user-1');
  });

  it('purges the Bots conversations after the computer and before the account row', async () => {
    const response = await createApp().request('/api/admin/users/user-1', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(mocks.purgeConversations).toHaveBeenCalledWith('user-1');
    const [purgeOrder] = mocks.purge.mock.invocationCallOrder;
    const [conversationsOrder] = mocks.purgeConversations.mock.invocationCallOrder;
    const [deleteOrder] = mocks.users.delete.mock.invocationCallOrder;
    expect(purgeOrder).toBeLessThan(conversationsOrder!);
    expect(conversationsOrder).toBeLessThan(deleteOrder!);
  });
});

describe('switching the bots feature off', () => {
  for (const [label, path, body] of [
    ['per-user toggle', '/api/admin/users/user-1/features', { feature: 'bots', enabled: false }],
    ['feature toggle', '/api/admin/features', { user_id: 'user-1', feature: 'bots', enabled: false }],
  ] as const) {
    it(`stops the member's Bots runs, then their computer (${label})`, async () => {
      const response = await createApp().request(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(mocks.stopBotsRuns).toHaveBeenCalledWith(expect.anything(), 'user-1');
      expect(mocks.purge).toHaveBeenCalledWith('user-1', { wipe: false, reason: 'admin' });
      expect(mocks.stopBotsRuns.mock.invocationCallOrder[0]).toBeLessThan(mocks.purge.mock.invocationCallOrder[0]!);
      // A switch-off is not a suspension or a deletion.
      expect(mocks.suspend).not.toHaveBeenCalled();
      expect(mocks.purgeConversations).not.toHaveBeenCalled();
    });
  }

  it('leaves runs and the computer alone when Bots is switched on, or another feature changes', async () => {
    for (const body of [
      { feature: 'bots', enabled: true },
      { feature: 'knowledge', enabled: false },
    ]) {
      const response = await createApp().request('/api/admin/users/user-1/features', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    }
    expect(mocks.stopBotsRuns).not.toHaveBeenCalled();
    expect(mocks.purge).not.toHaveBeenCalled();
  });
});
