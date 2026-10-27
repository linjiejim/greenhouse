import {
  createIdentityProviderRoutes,
  bindProviderIdentity,
  isLoginEligible,
  type IdentityProvider,
} from '@greenhouse/api/extension-kit';
import type { Handler } from 'hono';
/**
 * 飞书身份绑定与扫码登录 — /api/feishu
 *
 * GET    /api/feishu/oauth/start        — 起绑定授权，返回授权页 URL（需 Bearer）
 * GET    /api/feishu/oauth/start-login  — 起登录授权（公开，登录页未持有 token）；`?app_redirect=` 只认手机 App 的回跳地址（APP_LOGIN_REDIRECT），其他一律 400
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
 *
 * state 与兑换码都存在 `oauth_login_states`（只存 SHA-256，`consume` 是一条带
 * 条件的 UPDATE，并发下也只有一个赢家），所以重启不丢、多实例共享。
 */

import { Hono } from 'hono';
import crypto from 'node:crypto';
import { getDb } from '@greenhouse/api/extension-kit';
import { logger } from '@greenhouse/api/extension-kit';
import { toErrorMessage } from '@greenhouse/api/extension-kit';
import { getAuthUser } from '@greenhouse/api/extension-kit';
import { buildAuthorizeUrl, getFeishuConfig, resolveUserByCode } from './client.js';
import { issueUserSession } from '@greenhouse/api/extension-kit';
import { checkRateLimit } from '@greenhouse/api/extension-kit';
import { getRequestSourceIp } from '@greenhouse/api/extension-kit';
import type { AppEnv } from '@greenhouse/api/extension-kit';

export const FEISHU_PROVIDER = 'feishu';

// ─── Pending authorization state ─────────────────────────
//
// Stored in `oauth_login_states` (hashed, single use), so a restart or a second
// instance does not lose an in-flight login. Expired rows are swept by the
// five-minute upkeep tick in index.ts.

const STATE_TTL_MS = 10 * 60 * 1000;
/** Login exchange codes are consumed within one page load; keep them short. */
const LOGIN_CODE_TTL_MS = 60 * 1000;

interface PendingAuth {
  intent: 'bind' | 'login';
  /** Present only for bind states — the login flow does not know the user yet. */
  userId?: string;
  /** A login the phone app started: the callback returns to the app, not the web login page. */
  app?: true;
}

/**
 * The phone app's return address (apps/client app.json `scheme` + the sign-in path) — the ONLY
 * redirect a login may ask for. Exact match: no other scheme, host, path or query is accepted, so
 * the one-shot exchange code can never be sent anywhere but the app.
 */
export const APP_LOGIN_REDIRECT = 'greenhouse://auth/feishu';

export function isAllowedAppRedirect(value: unknown): value is typeof APP_LOGIN_REDIRECT {
  return value === APP_LOGIN_REDIRECT;
}

function asPendingAuth(payload: Record<string, unknown> | null): PendingAuth | null {
  if (!payload || (payload.intent !== 'bind' && payload.intent !== 'login')) return null;
  if (payload.intent === 'bind' && typeof payload.userId !== 'string') return null;
  return {
    intent: payload.intent,
    ...(typeof payload.userId === 'string' ? { userId: payload.userId } : {}),
    ...(payload.intent === 'login' && payload.app === true ? { app: true as const } : {}),
  };
}

function appRedirect(params: Record<string, string>): string {
  return `${APP_LOGIN_REDIRECT}?${new URLSearchParams(params).toString()}`;
}

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

async function issueState(entry: PendingAuth): Promise<string> {
  const state = crypto.randomBytes(32).toString('base64url');
  await getDb().oauthLoginStates.issue({
    value: state,
    provider: FEISHU_PROVIDER,
    kind: 'pending',
    payload: { ...entry },
    expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });
  return state;
}

export const feishuLoginRoutes = new Hono<AppEnv>()
  // Guard written here, not at the mount point: `/callback`, `/start-login` and
  // `/exchange` must stay public, so a blanket `.use('/api/feishu/*')` would
  // break them.

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
    // The phone app asks to come back to itself; nothing else may be named as a return address.
    const requested = c.req.query('app_redirect');
    if (requested !== undefined && !isAllowedAppRedirect(requested)) {
      return c.json({ error: 'app_redirect is not an allowed app address' }, 400);
    }

    const state = await issueState(requested !== undefined ? { intent: 'login', app: true } : { intent: 'login' });
    return c.json({ authorize_url: buildAuthorizeUrl(config, callbackUrl(c.req.url), state) });
  })

  .post('/oauth/exchange', async (c) => {
    // Public endpoint: rate-limit by source IP so the 60s code window cannot be
    // brute-forced (the code itself is 256 bits, this is defence in depth).
    const limit = await checkRateLimit(`feishu-exchange:${getRequestSourceIp(c)}`, 60_000, 10);
    if (!limit.allowed) return c.json({ error: 'Too many attempts. Please try again later.' }, 429);

    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code : '';
    // Single consumption before any other check, so a failed attempt cannot be
    // replayed either.
    const entry = code
      ? await getDb().oauthLoginStates.consume({ value: code, provider: FEISHU_PROVIDER, kind: 'login_code' })
      : null;
    if (!entry || typeof entry.userId !== 'string') {
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
  });

export const start: Handler<AppEnv> = async (c) => {
  const config = getFeishuConfig();
  if (!config) return c.json({ error: 'Feishu is not configured on this deployment' }, 503);

  const user = getAuthUser(c);
  const state = await issueState({ intent: 'bind', userId: user.id });
  return c.json({ authorize_url: buildAuthorizeUrl(config, callbackUrl(c.req.url), state) });
};

export const callback: Handler<AppEnv> = async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  // Without a valid state we cannot even know which flow this was; the
  // settings page is the safer landing spot (it requires a session anyway).
  if (!code || !state) return c.redirect(settingsRedirect(c.req.url, { feishu: 'error', reason: 'missing_params' }));

  // Single consumption: a replayed state must not bind or log in a second time.
  let entry: PendingAuth | null;
  try {
    entry = asPendingAuth(
      await getDb().oauthLoginStates.consume({ value: state, provider: FEISHU_PROVIDER, kind: 'pending' }),
    );
  } catch (err) {
    logger.error(`[Feishu] state lookup failed: ${toErrorMessage(err)}`);
    return c.redirect(settingsRedirect(c.req.url, { feishu: 'error', reason: 'server_error' }));
  }
  if (!entry) {
    return c.redirect(settingsRedirect(c.req.url, { feishu: 'error', reason: 'state_expired' }));
  }

  const fail = (reason: string) =>
    c.redirect(
      entry.intent === 'login'
        ? entry.app
          ? appRedirect({ feishu: 'error', reason })
          : loginRedirect(c.req.url, { feishu: 'error', reason })
        : settingsRedirect(c.req.url, { feishu: 'error', reason }),
    );

  const config = getFeishuConfig();
  if (!config) return fail('not_configured');

  try {
    const identity = await resolveUserByCode(config, code, callbackUrl(c.req.url));
    if (!identity) return fail('identity_failed');

    const db = getDb();

    if (entry.intent === 'bind') {
      const reason = await bindProviderIdentity(db, FEISHU_PROVIDER, entry.userId!, {
        id: identity.openId,
        name: identity.name,
      });
      if (reason) return fail(reason);

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
    await db.oauthLoginStates.issue({
      value: exchangeCode,
      provider: FEISHU_PROVIDER,
      kind: 'login_code',
      payload: { userId: user.id },
      expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_MS).toISOString(),
    });
    return c.redirect(
      entry.app ? appRedirect({ feishu_code: exchangeCode }) : loginRedirect(c.req.url, { feishu_code: exchangeCode }),
    );
  } catch (err) {
    logger.error(`[Feishu] callback failed: ${toErrorMessage(err)}`);
    return fail('server_error');
  }
};

export const identityProvider: IdentityProvider = {
  id: 'feishu',
  title: 'Feishu',
  icon: 'LogIn',
  login: true,
  bind: true,
  path: '/api/feishu',
  available: () => getFeishuConfig() !== null,
  start,
  callback,
};
export const feishuOAuthRoutes = createIdentityProviderRoutes(identityProvider).route('/', feishuLoginRoutes);
