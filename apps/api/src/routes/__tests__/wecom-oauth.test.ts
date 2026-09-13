/**
 * The two legs of WeCom binding authenticate differently, and getting that
 * backwards is exactly the bug the dashboard-oauth flow shipped once: `/start`
 * was a full-page redirect, which cannot send an Authorization header, so the
 * hop 401'd every time while the unit tests stayed green.
 *
 * So the boundary is asserted directly against `isPublicPath`, not against a
 * stubbed router. The configured-app suite below then pins the state machine
 * itself — issuance bound to a user, single consumption, TTL, the owner
 * re-read, and the one-identity-one-account guard — the same properties
 * dashboard-oauth.test.ts pins for its sibling flow.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

/** The owner recorded at /start, as re-read by /callback before it persists. */
let ownerRow: { id: string; role: string; status: string } | null = null;
/** An existing binding for the resolved WeCom identity, if any. */
let identityBinding: { user_id: string } | null = null;
const upsertBinding = vi.fn();

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({
    users: { getById: async (id: string) => (ownerRow && ownerRow.id === id ? ownerRow : null) },
    providerTokens: {
      upsert: upsertBinding,
      findByProviderUserId: async () => identityBinding,
      get: async () => null,
      delete: async () => {},
    },
  }),
}));

// Keep getWeComConfig real (it is a pure env read — the three-key gate is part
// of what we test); only the upstream identity exchange is stubbed.
vi.mock('../../wecom/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../wecom/client.js')>();
  return { ...actual, resolveUserByCode: vi.fn() };
});

import { isPublicPath } from '../../auth/middleware.js';
import { resolveUserByCode } from '../../wecom/client.js';
import { wecomOAuthRoutes } from '../wecom-oauth.js';

const resolveUserByCodeMock = vi.mocked(resolveUserByCode);

const ENV_KEYS = ['WECOM_CORP_ID', 'WECOM_AGENT_ID', 'WECOM_APP_SECRET', 'PUBLIC_BASE_URL'] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('WeCom OAuth auth boundary', () => {
  it('exempts only the callback from central auth', () => {
    // The callback is where WeCom redirects the BROWSER — no header is possible,
    // and `state` is the credential.
    expect(isPublicPath('/api/wecom/oauth/callback')).toBe(true);
    // Everything else must stay behind the Bearer: `/start` is the only hop that
    // can tell who is binding, and `/binding` reads and writes their row.
    expect(isPublicPath('/api/wecom/oauth/start')).toBe(false);
    expect(isPublicPath('/api/wecom/binding')).toBe(false);
  });

  it('exempts by exact path, not by prefix', () => {
    expect(isPublicPath('/api/wecom/oauth/callback/extra')).toBe(false);
    expect(isPublicPath('/api/wecom')).toBe(false);
  });
});

describe('WeCom OAuth without a configured app', () => {
  it('never hands out a consent URL to an unauthenticated caller', async () => {
    // Mounted bare here, with no central auth middleware ahead of it — the
    // status is therefore not meaningful (requireInternal assumes the middleware
    // already ran or 401'd). What matters is that nothing usable comes out.
    const res = await wecomOAuthRoutes.request('/oauth/start');
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain('authorize_url');
  });

  it('redirects the callback back to settings with a reason instead of erroring', async () => {
    // The user is mid-redirect in their browser; a JSON error body would be a
    // dead end. Every failure path lands them back on the settings page.
    const res = await wecomOAuthRoutes.request('/oauth/callback?code=x&state=y');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('wecom=error');
  });

  it('never treats a replayed or unknown state as valid', async () => {
    const res = await wecomOAuthRoutes.request('/oauth/callback?code=x&state=never-issued');
    expect(res.headers.get('location')).toContain('reason=state_expired');
  });
});

// ─── Configured app: the state machine itself ────────────

/**
 * Mount the routes the way `index.ts` does: the router carries its own guard on
 * `/oauth/start`, and nothing upstream authenticates `/callback`. `authedApp`
 * mimics the central Bearer middleware having resolved a user.
 */
function authedApp(user: { id: string; role: string } = { id: 'user-1', role: 'team' }) {
  return new Hono()
    .use('*', async (c, next) => {
      c.set('user' as never, { ...user, email: 'jim@example.test', status: 'active' } as never);
      await next();
    })
    .route('/', wecomOAuthRoutes);
}

/** Run /oauth/start and hand back the state it bound to the caller. */
async function issueState(app: ReturnType<typeof authedApp>): Promise<string> {
  const res = await app.request('/oauth/start');
  expect(res.status).toBe(200);
  const { authorize_url } = (await res.json()) as { authorize_url: string };
  const state = new URL(authorize_url).searchParams.get('state');
  expect(state).toBeTruthy();
  return state!;
}

describe('WeCom OAuth with a configured app', () => {
  beforeEach(() => {
    process.env.WECOM_CORP_ID = 'ww-test-corp';
    process.env.WECOM_AGENT_ID = '1000002';
    process.env.WECOM_APP_SECRET = 'wecom-app-secret-value';
    process.env.PUBLIC_BASE_URL = 'https://greenhouse.example.test';
    ownerRow = { id: 'user-1', role: 'team', status: 'active' };
    identityBinding = null;
    upsertBinding.mockReset();
    resolveUserByCodeMock.mockReset();
    resolveUserByCodeMock.mockResolvedValue({ userId: 'wecom-open-123', name: 'Jim' });
  });

  it('start hands the browser a consent URL with a fresh state and the registered callback — never the secret', async () => {
    const app = authedApp();
    const res = await app.request('/oauth/start');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('wecom-app-secret-value');

    const target = new URL((JSON.parse(body) as { authorize_url: string }).authorize_url);
    expect(target.origin).toBe('https://login.work.weixin.qq.com');
    expect(target.searchParams.get('appid')).toBe('ww-test-corp');
    expect(target.searchParams.get('agentid')).toBe('1000002');
    // 回调地址必须是绝对地址且与企微后台登记的完全一致，所以取 PUBLIC_BASE_URL
    // 而不是请求自己的 origin。
    expect(target.searchParams.get('redirect_uri')).toBe('https://greenhouse.example.test/api/wecom/oauth/callback');

    const second = await issueState(app);
    expect(target.searchParams.get('state')).not.toBe(second);
  });

  it('binds the WeCom identity to the account that STARTED the flow, storing no token', async () => {
    const app = authedApp();
    const state = await issueState(app);

    const res = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('wecom=ok');
    expect(upsertBinding).toHaveBeenCalledTimes(1);
    expect(upsertBinding.mock.calls[0][0]).toMatchObject({
      user_id: 'user-1',
      provider: 'wecom',
      provider_user_id: 'wecom-open-123',
      // 企微应用 token 是 corp 全局的、由 client 缓存——per-user 行没有凭证可存。
      access_token: null,
    });
  });

  it('the callback leg authenticates by state alone — no user middleware in sight', async () => {
    // WeCom redirects the BROWSER here; there is no Authorization header. The
    // state was issued through the authed leg, but the callback is served off a
    // bare mount (same module instance, same pending map).
    const state = await issueState(authedApp());

    const res = await wecomOAuthRoutes.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.headers.get('location')).toContain('wecom=ok');
    expect(upsertBinding).toHaveBeenCalledTimes(1);
  });

  it('consumes a state exactly once — a replay after a successful bind fails', async () => {
    const app = authedApp();
    const state = await issueState(app);

    await app.request(`/oauth/callback?code=abc&state=${state}`);
    const replay = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(replay.headers.get('location')).toContain('reason=state_expired');
    expect(upsertBinding).toHaveBeenCalledTimes(1);
  });

  it('consumes the state even when the attempt fails downstream', async () => {
    // A failed identity exchange must not leave the state alive for another try
    // — single consumption is unconditional.
    resolveUserByCodeMock.mockResolvedValue(null);
    const app = authedApp();
    const state = await issueState(app);

    const first = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(first.headers.get('location')).toContain('reason=identity_failed');

    const replay = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(replay.headers.get('location')).toContain('reason=state_expired');
    expect(upsertBinding).not.toHaveBeenCalled();
  });

  it('rejects a state past its ten-minute TTL', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-11T00:00:00Z'), toFake: ['Date'] });
    try {
      const app = authedApp();
      const state = await issueState(app);

      vi.setSystemTime(new Date('2026-08-11T00:11:00Z'));
      const res = await app.request(`/oauth/callback?code=abc&state=${state}`);
      expect(res.headers.get('location')).toContain('reason=state_expired');
      expect(upsertBinding).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-reads the owner and refuses to bind for a deactivated account', async () => {
    // The identity was recorded at /start; the account may have been disabled
    // during the ten-minute window. Binding it then would leave a working
    // notification channel on a revoked account.
    const app = authedApp();
    const state = await issueState(app);
    ownerRow = { id: 'user-1', role: 'team', status: 'disabled' };

    const res = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.headers.get('location')).toContain('reason=account_inactive');
    expect(upsertBinding).not.toHaveBeenCalled();
  });

  it('refuses just as firmly when the account is gone or demoted to external', async () => {
    const app = authedApp();

    const stateGone = await issueState(app);
    ownerRow = null;
    const gone = await app.request(`/oauth/callback?code=abc&state=${stateGone}`);
    expect(gone.headers.get('location')).toContain('reason=account_inactive');

    ownerRow = { id: 'user-1', role: 'team', status: 'active' };
    const stateExternal = await issueState(app);
    ownerRow = { id: 'user-1', role: 'external', status: 'active' };
    const external = await app.request(`/oauth/callback?code=abc&state=${stateExternal}`);
    expect(external.headers.get('location')).toContain('reason=account_inactive');

    expect(upsertBinding).not.toHaveBeenCalled();
  });

  it('one WeCom identity, one account: refuses an identity already bound to someone else', async () => {
    // Without this, two people could bind the same colleague and both receive
    // their notifications.
    identityBinding = { user_id: 'user-2' };
    const app = authedApp();
    const state = await issueState(app);

    const res = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.headers.get('location')).toContain('reason=already_bound');
    expect(upsertBinding).not.toHaveBeenCalled();
  });

  it('lets the same account re-bind its own identity (idempotent re-bind)', async () => {
    identityBinding = { user_id: 'user-1' };
    const app = authedApp();
    const state = await issueState(app);

    const res = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.headers.get('location')).toContain('wecom=ok');
    expect(upsertBinding).toHaveBeenCalledTimes(1);
  });
});
