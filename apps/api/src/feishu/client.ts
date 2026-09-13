/**
 * Feishu open-platform client — tenant token, OAuth identity, DM cards.
 *
 * Distinct from `@greenhouse/utils/feishu`, which is a stateless POST to a group
 * custom-bot webhook. That reaches a CHAT ROOM and cannot address a person;
 * this reaches a named `open_id`, which is what "notify me" requires. The two
 * coexist on purpose — broadcast and direct message are different acts (same
 * split as the WeCom pair, spec 20260824 D10).
 *
 * It lives here rather than in `@greenhouse/utils` because it is stateful: the
 * tenant access token is cached and refreshed, and utils' idiom is pure
 * functions (same reasoning as wecom/client.ts).
 *
 * Nothing is configured by default. Every entry point reports "not configured"
 * rather than pretending, so an unbound deployment shows no Feishu affordances
 * at all instead of buttons that 500.
 */

import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

const API_BASE = 'https://open.feishu.cn/open-apis';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export function getFeishuConfig(env: NodeJS.ProcessEnv = process.env): FeishuConfig | null {
  const appId = env.FEISHU_APP_ID?.trim();
  const appSecret = env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

export function isFeishuConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getFeishuConfig(env) !== null;
}

// ─── Tenant access token ─────────────────────────────────

/**
 * Feishu issues one tenant token per app with a ~2h lifetime and rate-limits
 * the token endpoint, so it must be cached rather than fetched per call.
 * In-process is enough for the single pm2 instance this deployment runs (same
 * limitation, and the same note, as the WeCom token cache).
 */
let cached: { token: string; expiresAt: number } | null = null;
/** Refresh this early so a token never expires mid-request. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Test seam — the token cache is module state. */
export function _resetFeishuTokenCache(): void {
  cached = null;
}

interface FeishuResponse {
  code?: number;
  msg?: string;
}

/** Feishu error codes that mean "the cached tenant token died early". */
const TOKEN_INVALID_CODES = new Set([99991661, 99991663, 99991668]);

async function getTenantToken(config: FeishuConfig, force = false): Promise<string | null> {
  if (!force && cached && cached.expiresAt > Date.now() + REFRESH_MARGIN_MS) return cached.token;
  try {
    const res = await fetch(`${API_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    });
    const body = (await res.json()) as FeishuResponse & { tenant_access_token?: string; expire?: number };
    if (body.code || !body.tenant_access_token) {
      logger.warn(`[Feishu] tenant token failed: ${body.code} ${body.msg ?? ''}`);
      return null;
    }
    cached = { token: body.tenant_access_token, expiresAt: Date.now() + (body.expire ?? 7200) * 1000 };
    return cached.token;
  } catch (err) {
    logger.warn(`[Feishu] tenant token threw: ${toErrorMessage(err)}`);
    return null;
  }
}

/** Call an authenticated Feishu endpoint, refreshing once on an expired token. */
async function callWithToken<T extends FeishuResponse>(
  config: FeishuConfig,
  path: string,
  init?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getTenantToken(config, attempt > 0);
    if (!token) return null;
    try {
      const res = await fetch(`${API_BASE}/${path}`, {
        ...init,
        headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as T;
      if (body.code && TOKEN_INVALID_CODES.has(body.code) && attempt === 0) continue;
      return body;
    } catch (err) {
      logger.warn(`[Feishu] request threw: ${toErrorMessage(err)}`);
      return null;
    }
  }
  return null;
}

// ─── OAuth identity ──────────────────────────────────────

export interface FeishuIdentity {
  openId: string;
  name?: string;
}

/**
 * The consent URL the browser navigates to. Rendered by Feishu as a QR /
 * one-tap confirmation page, so one entry point serves both binding and login.
 */
export function buildAuthorizeUrl(config: FeishuConfig, redirectUri: string, state: string): string {
  return (
    'https://accounts.feishu.cn/open-apis/authen/v1/authorize?' +
    new URLSearchParams({ client_id: config.appId, redirect_uri: redirectUri, state }).toString()
  );
}

/**
 * Resolve an OAuth authorization code to a Feishu open_id.
 *
 * Two hops: code → user access token (v2 token endpoint), then user access
 * token → user info. The user access token is used once and discarded — the
 * binding stores identity, not credentials (spec 20260824 D3).
 */
export async function resolveUserByCode(
  config: FeishuConfig,
  code: string,
  redirectUri: string,
): Promise<FeishuIdentity | null> {
  try {
    const tokenRes = await fetch(`${API_BASE}/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: config.appId,
        client_secret: config.appSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokenBody = (await tokenRes.json()) as FeishuResponse & { access_token?: string; error?: string };
    if (!tokenBody.access_token) {
      logger.warn(`[Feishu] oauth token exchange failed: ${tokenBody.code ?? tokenBody.error} ${tokenBody.msg ?? ''}`);
      return null;
    }

    const infoRes = await fetch(`${API_BASE}/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    const infoBody = (await infoRes.json()) as FeishuResponse & {
      data?: { open_id?: string; name?: string };
    };
    if (infoBody.code || !infoBody.data?.open_id) {
      logger.warn(`[Feishu] user_info failed: ${infoBody.code} ${infoBody.msg ?? ''}`);
      return null;
    }
    return { openId: infoBody.data.open_id, ...(infoBody.data.name ? { name: infoBody.data.name } : {}) };
  } catch (err) {
    logger.warn(`[Feishu] resolveUserByCode threw: ${toErrorMessage(err)}`);
    return null;
  }
}

// ─── Messaging ───────────────────────────────────────────

export interface FeishuSendResult {
  ok: boolean;
  error?: string;
}

/**
 * Wrap markdown in a Feishu interactive card — **card JSON 2.0**.
 *
 * The version is load-bearing, not boilerplate. 1.0's markdown component
 * renders bold/lists/links but silently emits ATX headings and GFM tables as
 * literal text, so `## 数据口径` and every `| col | col |` row reached the
 * reader as raw syntax (observed on the first real automation digest). 2.0's
 * markdown component renders the full GitHub-flavored set — headings, tables,
 * inline code — which is exactly what `flattenRichOutput()` produces.
 *
 * Deliberately headerless: the card title would duplicate the `**✅ <task>**`
 * line that `buildTaskNotification()` already puts at the top, and that
 * function is shared with the WeCom and in-app channels — bending it to give
 * Feishu a separate title field would make the three channels drift.
 */
export function buildMarkdownCard(content: string): Record<string, unknown> {
  return { schema: '2.0', body: { elements: [{ tag: 'markdown', content }] } };
}

/**
 * Send a markdown card DM to one user.
 *
 * `openId` is supplied by the CALLER, and every caller in this codebase derives
 * it from a stored binding rather than from configuration or model output —
 * that is what keeps the channel un-aimable, exactly as `notify_email` does by
 * being a boolean (spec 20260824 D4).
 */
export async function sendCardMarkdown(openId: string, content: string): Promise<FeishuSendResult> {
  const config = getFeishuConfig();
  if (!config) return { ok: false, error: 'Feishu app is not configured (FEISHU_APP_ID/APP_SECRET)' };

  const card = buildMarkdownCard(content);
  const body = await callWithToken<FeishuResponse>(config, 'im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  });

  if (!body) return { ok: false, error: 'Feishu request failed' };
  if (body.code) return { ok: false, error: `${body.code} ${body.msg ?? ''}`.trim() };
  return { ok: true };
}

/**
 * 回复某条消息（而不是新发一条）。
 *
 * 机器人的回答必须走 reply：这样用户后续对这条回答用「回复」时，事件里的
 * `root_id` 仍指向整条链最初那条消息——会话映射靠它保持稳定（bot spec D1）。
 * 新发一条会开一条新链，用户每回复一次就换一个会话。
 */
export async function replyCardMarkdown(messageId: string, content: string): Promise<FeishuSendResult> {
  const config = getFeishuConfig();
  if (!config) return { ok: false, error: 'Feishu app is not configured (FEISHU_APP_ID/APP_SECRET)' };

  const body = await callWithToken<FeishuResponse>(config, `im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(buildMarkdownCard(content)) }),
  });

  if (!body) return { ok: false, error: 'Feishu request failed' };
  if (body.code) return { ok: false, error: `${body.code} ${body.msg ?? ''}`.trim() };
  return { ok: true };
}
