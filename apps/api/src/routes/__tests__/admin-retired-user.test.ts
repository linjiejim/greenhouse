import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  users: {
    getById: vi.fn(),
    update: vi.fn(),
    updateAndRevokeSessions: vi.fn(),
    resetPasswordAndRevokeSessions: vi.fn(),
  },
  refreshTokens: {
    revokeAllForUser: vi.fn(),
  },
  platform: {
    syncLegacyRoleBinding: vi.fn(),
    recordAudit: vi.fn(),
  },
  usageBudget: {
    ensureMonthlyUserAccount: vi.fn(),
  },
}));

vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  getDb: () => mocks,
}));

import adminRoutes from '../admin.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'super-user', role: 'super' });
    return next();
  });
  app.route('/api/admin', adminRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.users.resetPasswordAndRevokeSessions.mockResolvedValue({ id: 'retired-user', auth_version: 1 });
  mocks.usageBudget.ensureMonthlyUserAccount.mockResolvedValue(undefined);
  mocks.users.getById.mockResolvedValue({
    id: 'retired-user',
    role: 'external',
    status: 'disabled',
    password_hash: 'EXTERNAL_ACCOUNT_RETIRED_NOLOGIN',
  });
});

describe('retired external account conversion', () => {
  it('cannot activate a historical external account without converting it to team', async () => {
    mocks.users.getById.mockResolvedValue({
      id: 'retired-user',
      role: 'external',
      status: 'disabled',
      password_hash: 'valid-replacement-hash',
    });

    const response = await createApp().request('/api/admin/users/retired-user', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Historical external accounts must be converted to team before activation',
    });
    expect(mocks.users.update).not.toHaveBeenCalled();
  });

  it('requires a password reset before the account can be activated', async () => {
    const response = await createApp().request('/api/admin/users/retired-user', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'team', status: 'active' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Reset this retired external account password before activation',
    });
    expect(mocks.users.update).not.toHaveBeenCalled();
  });

  it('converts and activates a historical external account atomically', async () => {
    const existing = {
      id: 'retired-user',
      email: 'retired@example.com',
      nickname: 'Retired User',
      role: 'external',
      status: 'disabled',
      password_hash: 'valid-replacement-hash',
    };
    mocks.users.getById.mockResolvedValue(existing);
    mocks.users.update.mockResolvedValue({ ...existing, role: 'team', status: 'active' });

    const response = await createApp().request('/api/admin/users/retired-user', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'team', status: 'active' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.users.update).toHaveBeenCalledWith('retired-user', { role: 'team', status: 'active' });
    expect(mocks.platform.syncLegacyRoleBinding).toHaveBeenCalledWith('retired-user', 'team', 'super-user');
  });

  it('atomically disables the account and invalidates its credential generation', async () => {
    const existing = {
      id: 'team-user',
      email: 'team@example.com',
      nickname: 'Team User',
      role: 'team',
      status: 'active',
      password_hash: 'hash',
      auth_version: 3,
    };
    mocks.users.getById.mockResolvedValue(existing);
    mocks.users.updateAndRevokeSessions.mockResolvedValue({ ...existing, status: 'disabled', auth_version: 4 });

    const response = await createApp().request('/api/admin/users/team-user', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.users.updateAndRevokeSessions).toHaveBeenCalledWith('team-user', { status: 'disabled' });
    expect(mocks.users.update).not.toHaveBeenCalled();
    expect(mocks.refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('ignores the retired daily-message limit while accepting the monthly token cap', async () => {
    const existing = {
      id: 'team-user',
      email: 'team@example.com',
      nickname: 'Team User',
      role: 'team',
      status: 'active',
      password_hash: 'hash',
      daily_message_limit: 200,
      monthly_token_limit: 20_000_000,
    };
    mocks.users.getById.mockResolvedValue(existing);
    mocks.users.update.mockResolvedValue({ ...existing, monthly_token_limit: 5_000_000 });

    const response = await createApp().request('/api/admin/users/team-user', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ daily_message_limit: 1, monthly_token_limit: 5_000_000 }),
    });

    expect(response.status).toBe(200);
    expect(mocks.users.update).toHaveBeenCalledWith('team-user', { monthly_token_limit: 5_000_000 });
  });

  it('resets the password through the atomic credential-revocation operation', async () => {
    const response = await createApp().request('/api/admin/users/retired-user/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'ReplacementPassword123!' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.users.resetPasswordAndRevokeSessions).toHaveBeenCalledWith(
      'retired-user',
      expect.stringMatching(/^[0-9a-f]{64}:[0-9a-f]{128}$/),
    );
    expect(mocks.refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
  });
});
