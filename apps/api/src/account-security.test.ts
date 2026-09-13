import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sharedMailbox: true,
  send: vi.fn(),
}));

vi.mock('./email/service.js', () => ({
  getSharedMailboxCredentials: () => (mocks.sharedMailbox ? { email_address: 'greenhouse@example.com' } : null),
  sendFromSharedMailbox: mocks.send,
}));
vi.mock('./chat-runs.js', () => ({ chatRunRegistry: { stopForUser: vi.fn() } }));
vi.mock('./ws/connection-manager.js', () => ({ connectionManager: { disconnectUser: vi.fn() } }));
vi.mock('./scheduler/index.js', () => ({ getScheduler: () => null }));
vi.mock('./cloud-agent/index.js', () => ({ getCloudAgentController: () => null }));
vi.mock('./workflow-engine/index.js', () => ({ getWorkflowEngine: () => ({ cancelRunsForUser: vi.fn() }) }));
vi.mock('./platform/runtime.js', () => ({ PLATFORM_ORG_ID: 'default' }));

const { deliverAccountPasswordLink, getPasswordLinkCapability, maskEmail } = await import('./account-security.js');

const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sharedMailbox = true;
  mocks.send.mockResolvedValue({ ok: true, messageId: 'message-1' });
  process.env.PUBLIC_BASE_URL = 'https://greenhouse.example.com';
});

afterEach(() => {
  if (originalPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
});

describe('account password-link delivery', () => {
  it('fails closed when the public base URL or shared mailbox is unavailable', () => {
    delete process.env.PUBLIC_BASE_URL;
    expect(getPasswordLinkCapability()).toEqual({ available: false, reason: 'missing_public_base_url' });

    process.env.PUBLIC_BASE_URL = 'http://greenhouse.example.com';
    expect(getPasswordLinkCapability()).toEqual({ available: false, reason: 'insecure_public_base_url' });

    process.env.PUBLIC_BASE_URL = 'https://greenhouse.example.com';
    mocks.sharedMailbox = false;
    expect(getPasswordLinkCapability()).toEqual({ available: false, reason: 'shared_mailbox_unconfigured' });
  });

  it('puts the bearer token only after the URL fragment and includes no login authority', async () => {
    const token = 'a'.repeat(43);
    await deliverAccountPasswordLink(
      {} as never,
      {
        token,
        link: {
          id: 'link-1',
          purpose: 'reset',
          expires_at: '2026-08-12T16:00:00.000Z',
        },
        user: { id: 'user-1', email: 'teammate@example.com', nickname: 'Team Mate' },
      } as never,
      { id: 'admin-1', email: 'admin@example.com', nickname: 'Admin' } as never,
    );

    const message = mocks.send.mock.calls[0]?.[2] as { body_text: string; body_html: string };
    expect(message.body_text).toContain(`https://greenhouse.example.com/#/activate?token=${token}`);
    expect(message.body_text).not.toContain(`greenhouse.example.com/?token=${token}`);
    expect(message.body_text).toContain('can only set your password');
    expect(message.body_html).toContain('#/activate?token=');
  });

  it('reveals only a small part of the mailbox local name', () => {
    expect(maskEmail('teammate@example.com')).toBe('te***@example.com');
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });
});
