/**
 * WeCom corporate-app client — access token, identity lookup, app messages.
 *
 * Distinct from `@greenhouse/utils/wecom`, which is a stateless POST to a group
 * robot webhook. That reaches a CHAT ROOM and cannot address a person; this
 * reaches a named `touser`, which is what "notify me" requires. The two coexist
 * on purpose (spec D7) — broadcast and direct message are different acts.
 *
 * It lives here rather than in `@greenhouse/utils` because it is stateful: the
 * access token is cached and refreshed, and utils' idiom is pure functions
 * (spec D8).
 *
 * Nothing is configured by default. Every entry point reports "not configured"
 * rather than pretending, so an unbound deployment shows no WeCom affordances
 * at all instead of buttons that 500.
 */

import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';

export interface WeComConfig {
  corpId: string;
  agentId: number;
  secret: string;
}

export function getWeComConfig(env: NodeJS.ProcessEnv = process.env): WeComConfig | null {
  const corpId = env.WECOM_CORP_ID?.trim();
  const secret = env.WECOM_APP_SECRET?.trim();
  const agentId = Number(env.WECOM_AGENT_ID);
  if (!corpId || !secret || !Number.isInteger(agentId) || agentId <= 0) return null;
  return { corpId, agentId, secret };
}

export function isWeComConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return getWeComConfig(env) !== null;
}

// ─── Access token ────────────────────────────────────────

/**
 * WeCom issues one token per (corpid, secret) with a ~2h lifetime and rate-limits
 * `gettoken`, so it must be cached rather than fetched per call. In-process is
 * enough for the single pm2 instance this deployment runs (same limitation, and
 * the same note, as the OAuth state map in dashboard-oauth.ts).
 */
let cached: { token: string; expiresAt: number } | null = null;
/** Refresh this early so a token never expires mid-request. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Test seam — the token cache is module state. */
export function _resetWeComTokenCache(): void {
  cached = null;
}

interface WeComResponse {
  errcode?: number;
  errmsg?: string;
}

async function getAccessToken(config: WeComConfig, force = false): Promise<string | null> {
  if (!force && cached && cached.expiresAt > Date.now() + REFRESH_MARGIN_MS) return cached.token;
  try {
    const url = `${API_BASE}/gettoken?corpid=${encodeURIComponent(config.corpId)}&corpsecret=${encodeURIComponent(config.secret)}`;
    const res = await fetch(url);
    const body = (await res.json()) as WeComResponse & { access_token?: string; expires_in?: number };
    if (body.errcode || !body.access_token) {
      logger.warn(`[WeCom] gettoken failed: ${body.errcode} ${body.errmsg ?? ''}`);
      return null;
    }
    cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 7200) * 1000 };
    return cached.token;
  } catch (err) {
    logger.warn(`[WeCom] gettoken threw: ${toErrorMessage(err)}`);
    return null;
  }
}

/**
 * Call an authenticated WeCom endpoint, refreshing once on an expired token.
 *
 * 42001/40014 mean the cached token died early (an admin reset the secret, or
 * another process rotated it). Retrying once with a forced refresh turns that
 * from a user-visible failure into a hiccup.
 */
async function callWithToken<T extends WeComResponse>(
  config: WeComConfig,
  path: (token: string) => string,
  init?: RequestInit,
): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(config, attempt > 0);
    if (!token) return null;
    try {
      const res = await fetch(`${API_BASE}/${path(token)}`, init);
      const body = (await res.json()) as T;
      if ((body.errcode === 42001 || body.errcode === 40014) && attempt === 0) continue;
      return body;
    } catch (err) {
      logger.warn(`[WeCom] request threw: ${toErrorMessage(err)}`);
      return null;
    }
  }
  return null;
}

// ─── Identity ────────────────────────────────────────────

export interface WeComIdentity {
  userId: string;
  name?: string;
}

/**
 * Resolve an OAuth code to a WeCom UserId.
 *
 * Only members of this corp come back with a `userid`; an external contact
 * returns `openid` instead, which we deliberately do not accept — this system
 * serves internal users only.
 */
export async function resolveUserByCode(config: WeComConfig, code: string): Promise<WeComIdentity | null> {
  const body = await callWithToken<WeComResponse & { userid?: string; openid?: string }>(
    config,
    (token) => `auth/getuserinfo?access_token=${token}&code=${encodeURIComponent(code)}`,
  );
  if (!body || body.errcode || !body.userid) {
    if (body?.openid) logger.warn('[WeCom] getuserinfo returned an external contact (openid); rejecting.');
    return null;
  }
  const detail = await callWithToken<WeComResponse & { name?: string }>(
    config,
    (token) => `user/get?access_token=${token}&userid=${encodeURIComponent(body.userid!)}`,
  );
  return { userId: body.userid, ...(detail && !detail.errcode && detail.name ? { name: detail.name } : {}) };
}

// ─── Messaging ───────────────────────────────────────────

export interface WeComSendResult {
  ok: boolean;
  error?: string;
}

/**
 * Send a markdown app message to one member.
 *
 * `touser` is supplied by the CALLER, and every caller in this codebase derives
 * it from a stored binding rather than from configuration or model output —
 * that is what keeps the channel un-aimable, exactly as `notify_email` does by
 * being a boolean (spec D3).
 *
 * Note: WeCom markdown app messages render only inside the WeCom client, not in
 * personal WeChat. Acceptable here — the whole team uses WeCom.
 */
export async function sendAppMarkdown(touser: string, content: string): Promise<WeComSendResult> {
  const config = getWeComConfig();
  if (!config) return { ok: false, error: 'WeCom app is not configured (WECOM_CORP_ID/AGENT_ID/APP_SECRET)' };

  const body = await callWithToken<WeComResponse>(config, (token) => `message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      touser,
      msgtype: 'markdown',
      agentid: config.agentId,
      markdown: { content },
    }),
  });

  if (!body) return { ok: false, error: 'WeCom request failed' };
  if (body.errcode) return { ok: false, error: `${body.errcode} ${body.errmsg ?? ''}`.trim() };
  return { ok: true };
}
