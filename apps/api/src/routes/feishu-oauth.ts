/**
 * 飞书身份绑定与扫码登录 — /api/feishu
 *
 * GET    /api/feishu/oauth/start        — 起绑定授权，返回授权页 URL（需 Bearer）
 * GET    /api/feishu/oauth/start-login  — 起登录授权（公开，登录页未持有 token）
 * GET    /api/feishu/oauth/callback     — 飞书把浏览器重定向回来（公开；按 state 的 intent 分流 bind/login）
 * POST   /api/feishu/oauth/exchange     — 一次性兑换码换正常会话（公开，限流）
 * GET    /api/feishu/binding            — 当前用户的绑定状态（需 Bearer）
 * DELETE /api/feishu/binding            — 解绑（需 Bearer）
 *
 * 绑定关系存 `user_provider_tokens(provider='feishu')`，`provider_user_id` 是
 * open_id，`access_token` 刻意为 NULL——推送用的 tenant token 是 app 全局的、由
 * feishu/client.ts 缓存，per-user 行没有凭证可存（spec 20260824 D2/D3）。
 *
 * **绑定与登录共用一个 callback，按 state 的 intent 分流**（spec D5）：飞书后台
 * 每条重定向 URL 都要登记，单 callback 少登记一条、state 语义集中一处。bind
 * state 绑死 userId，login state 不绑。
 *
 * 鉴权口径与 wecom-oauth 同款：`/oauth/start` 必须带 Bearer（「是谁在绑定」只有
 * 这一跳知道），返回 JSON 而不是 302（整页跳转发不出 header）；`/callback` 是
 * 飞书重定向浏览器过来的、没有 header，凭证就是 state（服务端生成、单次消费、
 * 10 分钟、bind 时绑死 userId），它进 `isPublicPath`，**永不调 `getAuthUser`**。
 * 登录回跳用 60s 单次消费的兑换码，长期凭证不进 URL（spec D6）。
 */

import { Hono } from 'hono';
import crypto from 'node:crypto';
import { getDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { getAuthUser, requireInternal } from '../auth/middleware.js';
import { buildAuthorizeUrl, getFeishuConfig, resolveUserByCode } from '../feishu/client.js';
import { issueUserSession } from './auth.js';
import { InMemoryRateLimiter } from '../security.js';
import { getRequestSourceIp } from '../request-ip.js';
import type { AppEnv } from '../app-env.js';
import type { UserRow } from '@greenhouse/db';

export const FEISHU_PROVIDER = 'feishu';

// ─── Pending authorization state ─────────────────────────
//
// Only meaningful for one round-trip (tens of seconds), so it lives in process
// memory rather than a table. A restart invalidates in-flight authorizations —
// the user clicks again. Multi-instance deployment would need shared storage
// (same known limitation as wecom-oauth.ts / dashboard-oauth.ts).

const STATE_TTL_MS = 10 * 60 * 1000;
/** Login exchange codes are consumed within one page load; keep them short. */
const LOGIN_CODE_TTL_MS = 60 * 1000;

interface PendingAuth {
  intent: 'bind' | 'login';
  /** Present only for bind states — the login flow does not know the user yet. */
  userId?: string;
  expiresAt: number;
}

const pending = new Map<string, PendingAuth>();
const loginCodes = new Map<string, { userId: string; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of pending) if (now >= entry.expiresAt) pending.delete(state);
  for (const [code, entry] of loginCodes) if (now >= entry.expiresAt) loginCodes.delete(code);
}, 60_000).unref();

const exchangeLimiter = new InMemoryRateLimiter();

function baseUrl(reqUrl: string): string {
  return (process.env.PUBLIC_BASE_URL || new URL(reqUrl).origin).replace(/\/$/, '');
}

function settingsRedirect(reqUrl: string, params: Record<string, string>): string {
  return `${baseUrl(reqUrl)}/#/settings/provider-bindings?${new URLSearchParams(params).toString()}`;
}

function loginRedirect(reqUrl: string, params: Record<string, string>): string {
  return `${baseUrl(reqUrl)}/#/login?${new URLSearchParams(params).toString()}`;
}

/**
 * The redirect target Feishu sends the browser back to. Must match what is
 * registered in the Feishu console EXACTLY (and is also required verbatim by
 * the token exchange), which is why it comes from `PUBLIC_BASE_URL` behind a
 * reverse proxy rather than from the request's own origin.
 */
function callbackUrl(reqUrl: string): string {
  return `${baseUrl(reqUrl)}/api/feishu/oauth/callback`;
}

/** Same gate as password login: active internal accounts only. */
function isLoginEligible(user: UserRow): boolean {
  return user.status === 'active' && (user.role === 'team' || user.role === 'super');
}

function issueState(entry: Omit<PendingAuth, 'expiresAt'>): string {
  const state = crypto.randomBytes(32).toString('base64url');
  pending.set(state, { ...entry, expiresAt: Date.now() + STATE_TTL_MS });
  return state;
}

export const feishuOAuthRoutes = new Hono<AppEnv>()
  // Guard written here, not at the mount point: `/callback`, `/start-login` and
  // `/exchange` must stay public, so a blanket `.use('/api/feishu/*')` would
  // break them.
  .use('/oauth/start', requireInternal())
  .use('/binding', requireInternal())

  .get('/oauth/start', async (c) => {
    const config = getFeishuConfig();
    if (!config) return c.json({ error: 'Feishu is not configured on this deployment' }, 503);

    const user = getAuthUser(c);
    const state = issueState({ intent: 'bind', userId: user.id });
    return c.json({ authorize_url: buildAuthorizeUrl(config, callbackUrl(c.req.url), state) });
  })

  /**
   * Is Feishu login offered at all? Public, read-only, and deliberately
   * SEPARATE from `/oauth/start-login`.
   *
   * The login screen asks this on every mount to decide whether to render the
   * button. Asking `start-login` instead would mean every page load — including
   * every plain password login — mints a pending state that nobody will ever
   * consume. A probe must not have side effects.
   */
  .get('/login-available', (c) => c.json({ available: getFeishuConfig() !== null }))

  .get('/oauth/start-login', async (c) => {
    const config = getFeishuConfig();
    if (!config) return c.json({ error: 'Feishu login is not configured on this deployment' }, 503);

    const state = issueState({ intent: 'login' });
    return c.json({ authorize_url: buildAuthorizeUrl(config, callbackUrl(c.req.url), state) });
  })

  .get('/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    // Without a valid state we cannot even know which flow this was; the
    // settings page is the safer landing spot (it requires a session anyway).
    if (!code || !state) return c.redirect(settingsRedirect(c.req.url, { feishu: 'error', reason: 'missing_params' }));

    // Single consumption: a replayed state must not bind or log in a second time.
    const entry = pending.get(state);
    pending.delete(state);
    if (!entry || Date.now() >= entry.expiresAt) {
      return c.redirect(settingsRedirect(c.req.url, { feishu: 'error', reason: 'state_expired' }));
    }

    const fail = (reason: string) =>
      c.redirect(
        entry.intent === 'login'
          ? loginRedirect(c.req.url, { feishu: 'error', reason })
          : settingsRedirect(c.req.url, { feishu: 'error', reason }),
      );

    const config = getFeishuConfig();
    if (!config) return fail('not_configured');

    try {
      const identity = await resolveUserByCode(config, code, callbackUrl(c.req.url));
      if (!identity) return fail('identity_failed');

      const db = getDb();

      if (entry.intent === 'bind') {
        // Re-read the owner before storing: the account may have been disabled
        // or demoted during the ten-minute window, and binding it then would
        // leave a working identity on a revoked account.
        const owner = await db.users.getById(entry.userId!);
        if (!owner || !isLoginEligible(owner)) return fail('account_inactive');

        // One Feishu identity, one account. Without this two people could bind
        // the same colleague and both receive their notifications.
        const existing = await db.providerTokens.findByProviderUserId(FEISHU_PROVIDER, identity.openId);
        if (existing && existing.user_id !== entry.userId) return fail('already_bound');

        await db.providerTokens.upsert({
          user_id: entry.userId!,
          provider: FEISHU_PROVIDER,
          workspace_id: null,
          provider_user_id: identity.openId,
          ...(identity.name ? { provider_name: identity.name } : {}),
          // Deliberately no token: the tenant token is app-global and lives in
          // the client's cache, not per user (see the schema note on the column).
          access_token: null,
        });

        return c.redirect(settingsRedirect(c.req.url, { feishu: 'ok' }));
      }

      // Login: the binding table is the lookup key. No binding, no session —
      // accounts are super-provisioned, never auto-created (wecom spec D4 holds
      // here unchanged).
      const binding = await db.providerTokens.findByProviderUserId(FEISHU_PROVIDER, identity.openId);
      if (!binding) return fail('not_bound');
      const user = await db.users.getById(binding.user_id);
      if (!user || !isLoginEligible(user)) return fail('account_inactive');

      const exchangeCode = crypto.randomBytes(32).toString('base64url');
      loginCodes.set(exchangeCode, { userId: user.id, expiresAt: Date.now() + LOGIN_CODE_TTL_MS });
      return c.redirect(loginRedirect(c.req.url, { feishu_code: exchangeCode }));
    } catch (err) {
      logger.error(`[Feishu] callback failed: ${toErrorMessage(err)}`);
      return fail('server_error');
    }
  })

  .post('/oauth/exchange', async (c) => {
    // Public endpoint: rate-limit by source IP so the 60s code window cannot be
    // brute-forced (the code itself is 256 bits, this is defence in depth).
    const limit = exchangeLimiter.check(`feishu-exchange:${getRequestSourceIp(c)}`, 60_000, 10);
    if (!limit.allowed) return c.json({ error: 'Too many attempts. Please try again later.' }, 429);

    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code : '';
    // Single consumption before any other check, so a failed attempt cannot be
    // replayed either.
    const entry = code ? loginCodes.get(code) : undefined;
    if (code) loginCodes.delete(code);
    if (!entry || Date.now() >= entry.expiresAt) {
      return c.json({ error: 'Login code is invalid or expired. Please scan again.' }, 401);
    }

    // Re-read at issuance time — the account may have been disabled between
    // callback and exchange.
    const user = await getDb().users.getById(entry.userId);
    if (!user || !isLoginEligible(user)) {
      return c.json({ error: 'Account is disabled. Contact your administrator.' }, 403);
    }

    c.header('Cache-Control', 'no-store');
    return c.json(await issueUserSession(user));
  })

  .get('/binding', async (c) => {
    const user = getAuthUser(c);
    const binding = await getDb().providerTokens.get(user.id, FEISHU_PROVIDER, null);
    return c.json({
      // `available` is what hides the affordance entirely on a deployment with
      // no Feishu app — a button that always 503s is a false capability claim.
      available: getFeishuConfig() !== null,
      binding: binding
        ? {
            provider_user_id: binding.provider_user_id,
            provider_name: binding.provider_name,
            bound_at: binding.updated_at,
          }
        : null,
    });
  })

  .delete('/binding', async (c) => {
    const user = getAuthUser(c);
    await getDb().providerTokens.delete(user.id, FEISHU_PROVIDER, null);
    return c.json({ ok: true });
  });
