import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  capability: { available: true } as { available: true } | { available: false; reason: string },
  users: {
    getByEmail: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
  },
  accountPasswordLinks: {
    issueInvite: vi.fn(),
    issueReset: vi.fn(),
    resend: vi.fn(),
    revokeCurrent: vi.fn(),
    markDelivery: vi.fn(),
  },
  platform: {
    syncLegacyRoleBinding: vi.fn(),
    recordAudit: vi.fn(),
  },
  deliver: vi.fn(),
  audit: vi.fn(),
  suspend: vi.fn(),
  resume: vi.fn(),
}));

vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  getDb: () => ({
    users: mocks.users,
    accountPasswordLinks: mocks.accountPasswordLinks,
    platform: mocks.platform,
  }),
}));

vi.mock('../../account-security.js', () => ({
  getPasswordLinkCapability: () => mocks.capability,
  deliverAccountPasswordLink: mocks.deliver,
  recordAccountSecurityAudit: mocks.audit,
  suspendUserRuntime: mocks.suspend,
  resumeUserRuntime: mocks.resume,
}));

const { default: adminRoutes } = await import('../admin.js');

const invitedUser = {
  id: 'user-1',
  email: 'teammate@example.com',
  nickname: 'Team Mate',
  role: 'team' as const,
  status: 'invited' as const,
  password_hash: '!account-password-not-set!',
  auth_version: 0,
  monthly_token_limit: 5_000_000,
  created_at: '2026-08-12T00:00:00.000Z',
};

const inviteLink = {
  id: 'link-1',
  user_id: invitedUser.id,
  purpose: 'invite' as const,
  token_hash: 'token-hash',
  issued_auth_version: 0,
  expires_at: '2026-08-15T00:00:00.000Z',
  consumed_at: null,
  revoked_at: null,
  created_by: 'super-user',
  created_at: '2026-08-12T00:00:00.000Z',
  sent_at: null,
  delivery_status: 'pending' as const,
  delivery_error: null,
};

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
  mocks.capability = { available: true };
  mocks.users.getByEmail.mockResolvedValue(undefined);
  mocks.users.getById.mockImplementation(async (id: string) =>
    id === 'super-user'
      ? { id, email: 'admin@example.com', nickname: 'Admin', role: 'super', status: 'active' }
      : invitedUser,
  );
  mocks.users.create.mockResolvedValue(invitedUser);
  mocks.accountPasswordLinks.issueInvite.mockResolvedValue({
    token: 'a'.repeat(43),
    link: inviteLink,
    user: invitedUser,
  });
  mocks.accountPasswordLinks.markDelivery.mockResolvedValue({
    ...inviteLink,
    sent_at: '2026-08-12T00:01:00.000Z',
    delivery_status: 'sent',
  });
  mocks.deliver.mockResolvedValue({ ok: true, messageId: 'message-1' });
});

describe('admin account password links', () => {
  it('creates an invited user without accepting or returning a temporary password', async () => {
    const response = await createApp().request('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: invitedUser.email,
        nickname: invitedUser.nickname,
        credential_mode: 'email_link',
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mocks.users.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'invited', password_hash: '!account-password-not-set!' }),
    );
    expect(mocks.accountPasswordLinks.issueInvite).toHaveBeenCalledWith(invitedUser.id, 'super-user');
    expect(JSON.stringify(body)).not.toContain('a'.repeat(43));
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actionId: 'issueAccountInvite', linkId: inviteLink.id }),
    );
  });

  it('refuses email mode before creating a user when deployment capability is incomplete', async () => {
    mocks.capability = { available: false, reason: 'shared_mailbox_unconfigured' };

    const response = await createApp().request('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: invitedUser.email, nickname: invitedUser.nickname, credential_mode: 'email_link' }),
    });

    expect(response.status).toBe(503);
    expect(mocks.users.create).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: 'Email password links are unavailable on this deployment.',
      reason: 'shared_mailbox_unconfigured',
    });
  });

  it('suspends runtime immediately after issuing a reset-required link', async () => {
    const activeUser = { ...invitedUser, status: 'active' as const, password_hash: 'old-hash', auth_version: 3 };
    const resetUser = { ...activeUser, status: 'reset_required' as const, auth_version: 4 };
    const resetLink = { ...inviteLink, purpose: 'reset' as const, issued_auth_version: 4 };
    mocks.users.getById.mockImplementation(async (id: string) =>
      id === 'super-user'
        ? { id, email: 'admin@example.com', nickname: 'Admin', role: 'super', status: 'active' }
        : activeUser,
    );
    mocks.accountPasswordLinks.issueReset.mockResolvedValue({
      token: 'b'.repeat(43),
      link: resetLink,
      user: resetUser,
    });
    mocks.accountPasswordLinks.markDelivery.mockResolvedValue({ ...resetLink, delivery_status: 'sent' });

    const response = await createApp().request(`/api/admin/users/${activeUser.id}/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'email_link' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.accountPasswordLinks.issueReset).toHaveBeenCalledWith(activeUser.id, 'super-user');
    expect(mocks.suspend).toHaveBeenCalledWith(activeUser.id);
    expect(mocks.suspend.mock.invocationCallOrder[0]).toBeLessThan(mocks.deliver.mock.invocationCallOrder[0]!);
    await expect(response.json()).resolves.toMatchObject({ user: { status: 'reset_required' } });
  });
});
