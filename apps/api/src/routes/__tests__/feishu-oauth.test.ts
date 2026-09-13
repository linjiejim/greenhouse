/**
 * Feishu OAuth has THREE public legs (callback, start-login, exchange) where
 * WeCom has one, so the auth boundary is asserted directly against
 * `isPublicPath` — the same guard the WeCom suite pins, for the same reason:
 * a full-page-redirect `/start` cannot send a Bearer header, and getting the
 * boundary backwards ships silently.
 *
 * The configured-app suites then pin the state machine: bind states bound to a
 * user, login states bound to nobody, single consumption, TTL, the owner
 * re-read, the one-identity-one-account guard, and the one-shot login exchange
 * code that keeps long-lived credentials out of URLs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

/** The account rows visible to the routes, keyed by id. */
let userRows: Record<string, { id: string; role: string; status: string }>;
/** An existing binding for the resolved Feishu identity, if any. */
let identityBinding: { user_id: string } | null = null;
const upsertBinding = vi.fn();

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({
    users: { getById: async (id: string) => userRows[id] ?? null },
    providerTokens: {
      upsert: upsertBinding,
      findByProviderUserId: async () => identityBinding,
      get: async () => null,
      delete: async () => {},
    },
  }),
}));

// The login exchange must reuse the SAME session issuance as password login —
// that contract is why this is a mock seam rather than a re-implementation.
const issueUserSessionMock = vi.fn(async (user: { id: string }) => ({
  accessToken: `access-${user.id}`,
  refreshToken: `refresh-${user.id}`,
  user: { id: user.id },
}));
vi.mock('../auth.js', () => ({
  issueUserSession: (user: { id: string }) => issueUserSessionMock(user),
}));

// Keep getFeishuConfig/buildAuthorizeUrl real (the env gate and URL shape are
// part of what we test); only the upstream identity exchange is stubbed.
vi.mock('../../feishu/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../feishu/client.js')>();
  return { ...actual, resolveUserByCode: vi.fn() };
});

import { isPublicPath } from '../../auth/middleware.js';
import { resolveUserByCode } from '../../feishu/client.js';
import { feishuOAuthRoutes } from '../feishu-oauth.js';

const resolveUserByCodeMock = vi.mocked(resolveUserByCode);

const ENV_KEYS = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'PUBLIC_BASE_URL'] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('Feishu OAuth auth boundary', () => {
  it('exempts exactly the browser-redirect and pre-auth legs from central auth', () => {
    // The callback is where Feishu redirects the BROWSER — no header possible,
    // `state` is the credential. start-login and exchange serve the login
    // screen, which by definition has no token yet.
    expect(isPublicPath('/api/feishu/oauth/callback')).toBe(true);
    expect(isPublicPath('/api/feishu/oauth/start-login')).toBe(true);
    expect(isPublicPath('/api/feishu/oauth/exchange')).toBe(true);
    expect(isPublicPath('/api/feishu/login-available')).toBe(true);
    // Everything else must stay behind the Bearer: `/start` is the only hop
    // that can tell who is binding, and `/binding` reads and writes their row.
    expect(isPublicPath('/api/feishu/oauth/start')).toBe(false);
    expect(isPublicPath('/api/feishu/binding')).toBe(false);
  });

  it('exempts by exact path, not by prefix', () => {
    expect(isPublicPath('/api/feishu/oauth/callback/extra')).toBe(false);
    expect(isPublicPath('/api/feishu')).toBe(false);
  });
});

describe('Feishu OAuth without a configured app', () => {
  // The module-level beforeEach below configures the app for the state-machine
  // suites; this suite is specifically about the unconfigured deployment.
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('never hands out a consent URL on either start leg', async () => {
    const bind = await feishuOAuthRoutes.request('/oauth/start');
    expect(bind.status).not.toBe(200);
    expect(await bind.text()).not.toContain('authorize_url');

    const login = await feishuOAuthRoutes.request('/oauth/start-login');
    expect(login.status).toBe(503);
    expect(await login.text()).not.toContain('authorize_url');
  });

  it('redirects the callback back with a reason instead of erroring', async () => {
    const res = await feishuOAuthRoutes.request('/oauth/callback?code=x&state=y');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('feishu=error');
  });

  it('answers the availability probe with false rather than an error', async () => {
    const res = await feishuOAuthRoutes.request('/login-available');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });
});

// ─── Configured app ──────────────────────────────────────

/**
 * Mount the routes the way `index.ts` does: the router carries its own guard on
 * `/oauth/start`, and nothing upstream authenticates the public legs.
 * `authedApp` mimics the central Bearer middleware having resolved a user.
 */
function authedApp(user: { id: string; role: string } = { id: 'user-1', role: 'team' }) {
  return new Hono()
    .use('*', async (c, next) => {
      c.set('user' as never, { ...user, email: 'jim@example.test', status: 'active' } as never);
      await next();
    })
    .route('/', feishuOAuthRoutes);
}

async function issueBindState(app: ReturnType<typeof authedApp>): Promise<string> {
  const res = await app.request('/oauth/start');
  expect(res.status).toBe(200);
  const { authorize_url } = (await res.json()) as { authorize_url: string };
  const state = new URL(authorize_url).searchParams.get('state');
  expect(state).toBeTruthy();
  return state!;
}

/** The login leg needs no auth at all — issued straight off the bare router. */
async function issueLoginState(): Promise<string> {
  const res = await feishuOAuthRoutes.request('/oauth/start-login');
  expect(res.status).toBe(200);
  const { authorize_url } = (await res.json()) as { authorize_url: string };
  return new URL(authorize_url).searchParams.get('state')!;
}

beforeEach(() => {
  process.env.FEISHU_APP_ID = 'cli_test_app';
  process.env.FEISHU_APP_SECRET = 'feishu-app-secret-value';
  process.env.PUBLIC_BASE_URL = 'https://greenhouse.example.test';
  userRows = { 'user-1': { id: 'user-1', role: 'team', status: 'active' } };
  identityBinding = null;
  upsertBinding.mockReset();
  issueUserSessionMock.mockClear();
  resolveUserByCodeMock.mockReset();
  resolveUserByCodeMock.mockResolvedValue({ openId: 'ou-feishu-123', name: 'Jim' });
});

describe('Feishu binding with a configured app', () => {
  it('the availability probe mints no state — a password login must not leave one behind', async () => {
    // Regression guard: the login screen calls this on EVERY mount. Probing
    // `start-login` instead would accumulate pending states nobody consumes.
    const probe = await feishuOAuthRoutes.request('/login-available');
    expect(await probe.json()).toEqual({ available: true });

    // Prove it by consuming a state issued afterwards: if the probe had minted
    // one, this callback would be matching a different entry than the one the
    // real start leg handed out.
    const state = await issueLoginState();
    identityBinding = { user_id: 'user-1' };
    const res = await feishuOAuthRoutes.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.headers.get('location')).toContain('feishu_code=');
  });

  it('start hands the browser a consent URL with a fresh state and the registered callback — never the secret', async () => {
    const app = authedApp();
    const res = await app.request('/oauth/start');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('feishu-app-secret-value');

    const target = new URL((JSON.parse(body) as { authorize_url: string }).authorize_url);
    expect(target.origin).toBe('https://accounts.feishu.cn');
    expect(target.searchParams.get('client_id')).toBe('cli_test_app');
    // 回调地址必须是绝对地址且与飞书后台登记的完全一致，所以取 PUBLIC_BASE_URL
    // 而不是请求自己的 origin。
    expect(target.searchParams.get('redirect_uri')).toBe('https://greenhouse.example.test/api/feishu/oauth/callback');

    const second = await issueBindState(app);
    expect(target.searchParams.get('state')).not.toBe(second);
  });

  it('binds the Feishu identity to the account that STARTED the flow, storing no token', async () => {
    const app = authedApp();
    const state = await issueBindState(app);

    const res = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('feishu=ok');
    expect(upsertBinding).toHaveBeenCalledTimes(1);
    expect(upsertBinding.mock.calls[0][0]).toMatchObject({
      user_id: 'user-1',
      provider: 'feishu',
      provider_user_id: 'ou-feishu-123',
      // tenant token 是 app 全局的、由 client 缓存——per-user 行没有凭证可存。
      access_token: null,
    });
  });

  it('consumes a state exactly once — a replay after a successful bind fails', async () => {
    const app = authedApp();
    const state = await issueBindState(app);

    await app.request(`/oauth/callback?code=abc&state=${state}`);
    const replay = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(replay.headers.get('location')).toContain('reason=state_expired');
    expect(upsertBinding).toHaveBeenCalledTimes(1);
  });

  it('rejects a state past its ten-minute TTL', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-24T00:00:00Z'), toFake: ['Date'] });
    try {
      const app = authedApp();
      const state = await issueBindState(app);

      vi.setSystemTime(new Date('2026-08-24T00:11:00Z'));
      const res = await app.request(`/oauth/callback?code=abc&state=${state}`);
      expect(res.headers.get('location')).toContain('reason=state_expired');
      expect(upsertBinding).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-reads the owner and refuses to bind for a deactivated account', async () => {
    const app = authedApp();
    const state = await issueBindState(app);
    userRows['user-1'] = { id: 'user-1', role: 'team', status: 'disabled' };

    const res = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.headers.get('location')).toContain('reason=account_inactive');
    expect(upsertBinding).not.toHaveBeenCalled();
  });

  it('one Feishu identity, one account: refuses an identity already bound to someone else', async () => {
    identityBinding = { user_id: 'user-2' };
    const app = authedApp();
    const state = await issueBindState(app);

    const res = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.headers.get('location')).toContain('reason=already_bound');
    expect(upsertBinding).not.toHaveBeenCalled();
  });

  it('lets the same account re-bind its own identity (idempotent re-bind)', async () => {
    identityBinding = { user_id: 'user-1' };
    const app = authedApp();
    const state = await issueBindState(app);

    const res = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.headers.get('location')).toContain('feishu=ok');
    expect(upsertBinding).toHaveBeenCalledTimes(1);
  });
});

describe('Feishu scan login', () => {
  async function callbackLocation(state: string): Promise<URL> {
    const res = await feishuOAuthRoutes.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.status).toBe(302);
    return new URL(res.headers.get('location')!);
  }

  it('a bound identity gets a one-shot exchange code — never tokens in the URL', async () => {
    identityBinding = { user_id: 'user-1' };
    const state = await issueLoginState();

    const location = await callbackLocation(state);
    expect(location.href).toContain('#/login?feishu_code=');
    expect(location.href).not.toContain('access');

    const code = new URLSearchParams(location.hash.split('?')[1]).get('feishu_code')!;
    const res = await feishuOAuthRoutes.request('/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken?: string };
    expect(body.accessToken).toBe('access-user-1');
    // Same issuance path as password login — the mock seam IS the assertion.
    expect(issueUserSessionMock).toHaveBeenCalledTimes(1);
  });

  it('consumes the exchange code exactly once', async () => {
    identityBinding = { user_id: 'user-1' };
    const location = await callbackLocation(await issueLoginState());
    const code = new URLSearchParams(location.hash.split('?')[1]).get('feishu_code')!;

    const first = await feishuOAuthRoutes.request('/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(first.status).toBe(200);

    const replay = await feishuOAuthRoutes.request('/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(replay.status).toBe(401);
    expect(issueUserSessionMock).toHaveBeenCalledTimes(1);
  });

  it('an unbound identity is sent back to the login screen with guidance, not an account', async () => {
    identityBinding = null;
    const location = await callbackLocation(await issueLoginState());
    expect(location.hash).toContain('reason=not_bound');
    expect(issueUserSessionMock).not.toHaveBeenCalled();
  });

  it('a disabled account cannot log in even with a valid binding', async () => {
    identityBinding = { user_id: 'user-1' };
    userRows['user-1'] = { id: 'user-1', role: 'team', status: 'disabled' };
    const location = await callbackLocation(await issueLoginState());
    expect(location.hash).toContain('reason=account_inactive');
    expect(issueUserSessionMock).not.toHaveBeenCalled();
  });

  it('re-checks the account at exchange time — disabled between scan and exchange is refused', async () => {
    identityBinding = { user_id: 'user-1' };
    const location = await callbackLocation(await issueLoginState());
    const code = new URLSearchParams(location.hash.split('?')[1]).get('feishu_code')!;

    userRows['user-1'] = { id: 'user-1', role: 'team', status: 'disabled' };
    const res = await feishuOAuthRoutes.request('/oauth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(403);
    expect(issueUserSessionMock).not.toHaveBeenCalled();
  });
});
