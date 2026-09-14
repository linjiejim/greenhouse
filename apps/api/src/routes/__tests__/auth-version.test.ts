import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  updateLastLogin: vi.fn(),
  inspectPasswordLink: vi.fn(),
  completePasswordLink: vi.fn(),
  recordAudit: vi.fn(),
}));

// Partial mock: keep the real module's other exports (the extension seam calls
// `registerExtensionServices` at import time, so a bare object mock breaks as
// soon as a deployment enables an extension that has services).
vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  getDb: () => ({
    refreshTokens: { consume: mocks.consume, create: mocks.create },
    users: { getById: mocks.getById, updateLastLogin: mocks.updateLastLogin },
    accountPasswordLinks: { inspect: mocks.inspectPasswordLink, complete: mocks.completePasswordLink },
    platform: { recordAudit: mocks.recordAudit },
  }),
  hashAccountPasswordToken: (token: string) => (/^[A-Za-z0-9_-]{43}$/.test(token) ? 'hashed-token' : null),
}));

process.env.TOKEN_SIGNING_KEY = '55'.repeat(32);

import { validateAccessToken } from '../../auth/token.js';
import authRoutes from '../auth.js';

function createApp() {
  return new Hono<AppEnv>().route('/api/auth', authRoutes);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue('new-refresh-id');
});

describe('refresh-token credential version', () => {
  it('rejects a consumed refresh token from an older password generation', async () => {
    mocks.consume.mockResolvedValue({ user_id: 'user-1', auth_version: 4 });
    mocks.getById.mockResolvedValue({
      id: 'user-1',
      email: 'user@test.local',
      nickname: 'User',
      role: 'team',
      status: 'active',
      auth_version: 5,
      daily_message_limit: 200,
      monthly_token_limit: 20_000_000,
      locale: 'en',
    });

    const response = await createApp().request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'old-refresh-token' }),
    });

    expect(response.status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('carries the current version into both rotated credentials', async () => {
    mocks.consume.mockResolvedValue({ user_id: 'user-1', auth_version: 5 });
    mocks.getById.mockResolvedValue({
      id: 'user-1',
      email: 'user@test.local',
      nickname: 'User',
      role: 'team',
      status: 'active',
      auth_version: 5,
      daily_message_limit: 200,
      monthly_token_limit: 20_000_000,
      locale: 'en',
    });

    const response = await createApp().request('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'current-refresh-token' }),
    });
    const body = (await response.json()) as { accessToken: string };

    expect(response.status).toBe(200);
    expect(validateAccessToken(body.accessToken)?.authVersion).toBe(5);
    expect(mocks.create).toHaveBeenCalledWith('user-1', expect.any(String), expect.any(String), 5);
  });
});

describe('public password-link completion', () => {
  const validToken = 'a'.repeat(43);

  it('inspects without consuming and returns only masked account metadata', async () => {
    mocks.inspectPasswordLink.mockResolvedValue({
      link: { purpose: 'invite', expires_at: '2026-08-13T00:00:00.000Z' },
      user: { email: 'teammate@example.com' },
    });

    const response = await createApp().request('/api/auth/password-link/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: validToken }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      purpose: 'invite',
      masked_email: 'te***@example.com',
      expires_at: '2026-08-13T00:00:00.000Z',
    });
    expect(mocks.completePasswordLink).not.toHaveBeenCalled();
  });

  it('uses the same public error for malformed and missing links', async () => {
    mocks.inspectPasswordLink.mockResolvedValue(null);
    const response = await createApp().request('/api/auth/password-link/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-token' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'This password link is invalid or expired.' });
  });

  it('returns a normal authenticated session only after password completion', async () => {
    const user = {
      id: 'invited-user',
      email: 'teammate@example.com',
      nickname: 'Team Mate',
      role: 'team',
      status: 'active',
      auth_version: 1,
      monthly_token_limit: 5_000_000,
      locale: 'en',
    };
    const link = { id: 'link-1', purpose: 'invite', expires_at: '2026-08-13T00:00:00.000Z' };
    mocks.inspectPasswordLink.mockResolvedValue({ link, user });
    mocks.completePasswordLink.mockResolvedValue({ link, user });

    const response = await createApp().request('/api/auth/password-link/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: validToken, password: 'ReplacementPassword123!' }),
    });
    const body = (await response.json()) as { accessToken: string; refreshToken: string };

    expect(response.status).toBe(200);
    expect(validateAccessToken(body.accessToken)).toMatchObject({ uid: user.id, authVersion: 1 });
    expect(body.refreshToken).toBeTruthy();
    expect(mocks.create).toHaveBeenCalledWith(user.id, expect.any(String), expect.any(String), 1);
    expect(mocks.recordAudit).toHaveBeenCalled();
  });
});
