import {
  createIdentityProviderRoutes,
  bindProviderIdentity,
  type IdentityProvider,
} from '@greenhouse/api/extension-kit';
import type { Handler } from 'hono';
/**
 * WeCom identity binding — /api/wecom/oauth
 *
 * GET /api/wecom/oauth/start     — 起授权，返回扫码页 URL（需 Bearer）
 * GET /api/wecom/oauth/callback  — 企微把浏览器重定向回来，落库后 302 回客户端绑定结果页 /bindings（公开）
 * GET /api/wecom/binding         — 当前用户的绑定状态（需 Bearer）
 * DELETE /api/wecom/binding      — 解绑（需 Bearer）
 *
 * 绑定关系存在 `user_provider_tokens(provider='wecom')`：那张表本来就是通用的
 * （`provider` + `provider_user_id`），所以这里零 schema 改动（spec D2）。刻意
 * **不存 access token**——企微应用 token 是整个 corp app 全局的、由 client.ts
 * 缓存，不是 per-user 的东西。
 *
 * **两条腿的鉴权刻意不同**，与 dashboard-oauth 同款理由：
 *  - `/start` 是页面发起的 fetch，带得了 Bearer，所以它必须带——「是谁在绑定」
 *    只有这一跳知道；它因此返回 JSON 而不是 302（整页跳转发不出 header）。
 *  - `/callback` 是企微**重定向浏览器**过来的，没有任何 header。凭证就是 `state`：
 *    服务端生成、单次消费、10 分钟过期、绑死 userId。它进 `isPublicPath`，
 *    **永不调 `getAuthUser`**。state 存在 `oauth_login_states`（只存 SHA-256，
 *    单条条件 UPDATE 消费），重启不丢、多实例共享。
 */

import crypto from 'node:crypto';
import { CLIENT_ROUTES, clientRouteUrl } from '@greenhouse/types/client-routes';
import { getDb } from '@greenhouse/api/extension-kit';
import { logger } from '@greenhouse/api/extension-kit';
import { toErrorMessage } from '@greenhouse/api/extension-kit';
import { getAuthUser } from '@greenhouse/api/extension-kit';
import { getWeComConfig, resolveUserByCode } from './client.js';
import type { AppEnv } from '@greenhouse/api/extension-kit';

export const WECOM_PROVIDER = 'wecom';

// ─── Pending authorization state ─────────────────────────
//
// Stored in `oauth_login_states` (hashed, single use), so a restart or a second
// instance does not lose an in-flight binding. Expired rows are swept by the
// five-minute upkeep tick in index.ts.

const STATE_TTL_MS = 10 * 60 * 1000;

/** The client's binding landing (`?wecom=ok|error&reason=`); it shows the result and where the binding lives. */
function settingsRedirect(reqUrl: string, params: Record<string, string>): string {
  const base = (process.env.PUBLIC_BASE_URL || new URL(reqUrl).origin).replace(/\/$/, '');
  return clientRouteUrl(base, CLIENT_ROUTES.bindings, { query: params });
}

/**
 * The redirect target WeCom will send the browser back to.
 *
 * Must match what is registered in the WeCom console EXACTLY, which is why it
 * comes from `PUBLIC_BASE_URL` behind a reverse proxy rather than from the
 * request's own origin.
 */
function callbackUrl(reqUrl: string): string {
  const base = (process.env.PUBLIC_BASE_URL || new URL(reqUrl).origin).replace(/\/$/, '');
  return `${base}/api/wecom/oauth/callback`;
}

export const start: Handler<AppEnv> = async (c) => {
  const config = getWeComConfig();
  if (!config) return c.json({ error: 'WeCom is not configured on this deployment' }, 503);

  const user = getAuthUser(c);
  const state = crypto.randomBytes(32).toString('base64url');
  await getDb().oauthLoginStates.issue({
    value: state,
    provider: WECOM_PROVIDER,
    kind: 'pending',
    payload: { userId: user.id },
    expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString(),
  });

  // The QR variant works both inside the WeCom client and in an ordinary
  // browser, so one entry point covers both without sniffing the UA.
  const authorizeUrl =
    'https://login.work.weixin.qq.com/wwlogin/sso/login?' +
    new URLSearchParams({
      login_type: 'CorpApp',
      appid: config.corpId,
      agentid: String(config.agentId),
      redirect_uri: callbackUrl(c.req.url),
      state,
    }).toString();

  return c.json({ authorize_url: authorizeUrl });
};

export const callback: Handler<AppEnv> = async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason: 'missing_params' }));

  // Single consumption: a replayed state must not bind a second time.
  let entry: { userId: string } | null;
  try {
    const consumed = await getDb().oauthLoginStates.consume({
      value: state,
      provider: WECOM_PROVIDER,
      kind: 'pending',
    });
    entry = typeof consumed?.userId === 'string' ? { userId: consumed.userId } : null;
  } catch (err) {
    logger.error(`[WeCom] state lookup failed: ${toErrorMessage(err)}`);
    return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason: 'server_error' }));
  }
  if (!entry) {
    return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason: 'state_expired' }));
  }

  const config = getWeComConfig();
  if (!config) return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason: 'not_configured' }));

  try {
    const identity = await resolveUserByCode(config, code);
    if (!identity) return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason: 'identity_failed' }));

    const reason = await bindProviderIdentity(getDb(), WECOM_PROVIDER, entry.userId, {
      id: identity.userId,
      name: identity.name,
    });
    if (reason) return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason }));

    return c.redirect(settingsRedirect(c.req.url, { wecom: 'ok' }));
  } catch (err) {
    logger.error(`[WeCom] binding failed: ${toErrorMessage(err)}`);
    return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason: 'server_error' }));
  }
};

export const identityProvider: IdentityProvider = {
  id: 'wecom',
  title: 'WeCom',
  icon: 'LogIn',
  login: false,
  bind: true,
  path: '/api/wecom',
  available: () => getWeComConfig() !== null,
  start,
  callback,
};
export const wecomOAuthRoutes = createIdentityProviderRoutes(identityProvider);
