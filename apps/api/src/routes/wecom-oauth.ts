/**
 * WeCom identity binding — /api/wecom/oauth
 *
 * GET /api/wecom/oauth/start     — 起授权，返回扫码页 URL（需 Bearer）
 * GET /api/wecom/oauth/callback  — 企微把浏览器重定向回来，落库后 302 回设置页（公开）
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
 *    **永不调 `getAuthUser`**。
 */

import { Hono } from 'hono';
import crypto from 'node:crypto';
import { getDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { getAuthUser, requireInternal } from '../auth/middleware.js';
import { getWeComConfig, resolveUserByCode } from '../wecom/client.js';
import type { AppEnv } from '../app-env.js';

export const WECOM_PROVIDER = 'wecom';

// ─── Pending authorization state ─────────────────────────
//
// Only meaningful for one round-trip (tens of seconds), so it lives in process
// memory rather than a table. A restart invalidates in-flight authorizations —
// the user clicks again. Multi-instance deployment would need shared storage
// (same known limitation as dashboard-oauth.ts).

const STATE_TTL_MS = 10 * 60 * 1000;

interface PendingAuth {
  userId: string;
  expiresAt: number;
}

const pending = new Map<string, PendingAuth>();

setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of pending) if (now >= entry.expiresAt) pending.delete(state);
}, 60_000).unref();

function settingsRedirect(reqUrl: string, params: Record<string, string>): string {
  const base = (process.env.PUBLIC_BASE_URL || new URL(reqUrl).origin).replace(/\/$/, '');
  return `${base}/#/settings/provider-bindings?${new URLSearchParams(params).toString()}`;
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

export const wecomOAuthRoutes = new Hono<AppEnv>()
  // Guard written here, not at the mount point: `/callback` must stay public,
  // so a blanket `.use('/api/wecom/*')` would break it.
  .use('/oauth/start', requireInternal())
  .use('/binding', requireInternal())

  .get('/oauth/start', async (c) => {
    const config = getWeComConfig();
    if (!config) return c.json({ error: 'WeCom is not configured on this deployment' }, 503);

    const user = getAuthUser(c);
    const state = crypto.randomBytes(32).toString('base64url');
    pending.set(state, { userId: user.id, expiresAt: Date.now() + STATE_TTL_MS });

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
  })

  .get('/oauth/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason: 'missing_params' }));

    // Single consumption: a replayed state must not bind a second time.
    const entry = pending.get(state);
    pending.delete(state);
    if (!entry || Date.now() >= entry.expiresAt) {
      return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason: 'state_expired' }));
    }

    const config = getWeComConfig();
    if (!config) return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason: 'not_configured' }));

    try {
      const identity = await resolveUserByCode(config, code);
      if (!identity) return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason: 'identity_failed' }));

      // Re-read the owner before storing: the account may have been disabled or
      // demoted during the ten-minute window, and binding it then would leave a
      // working key on a revoked account.
      const db = getDb();
      const owner = await db.users.getById(entry.userId);
      if (!owner || owner.status !== 'active' || (owner.role !== 'team' && owner.role !== 'super')) {
        return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason: 'account_inactive' }));
      }

      // One WeCom identity, one account. Without this two people could bind the
      // same colleague and both receive their notifications.
      const existing = await db.providerTokens.findByProviderUserId(WECOM_PROVIDER, identity.userId);
      if (existing && existing.user_id !== entry.userId) {
        return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason: 'already_bound' }));
      }

      await db.providerTokens.upsert({
        user_id: entry.userId,
        provider: WECOM_PROVIDER,
        workspace_id: null,
        provider_user_id: identity.userId,
        ...(identity.name ? { provider_name: identity.name } : {}),
        // Deliberately no token: the app access token is corp-global and lives
        // in the client's cache, not per user (see the schema note on the column).
        access_token: null,
      });

      return c.redirect(settingsRedirect(c.req.url, { wecom: 'ok' }));
    } catch (err) {
      logger.error(`[WeCom] binding failed: ${toErrorMessage(err)}`);
      return c.redirect(settingsRedirect(c.req.url, { wecom: 'error', reason: 'server_error' }));
    }
  })

  .get('/binding', async (c) => {
    const user = getAuthUser(c);
    const binding = await getDb().providerTokens.get(user.id, WECOM_PROVIDER, null);
    return c.json({
      // `available` is what hides the affordance entirely on a deployment with
      // no WeCom app — a button that always 503s is a false capability claim.
      available: getWeComConfig() !== null,
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
    await getDb().providerTokens.delete(user.id, WECOM_PROVIDER, null);
    return c.json({ ok: true });
  });
