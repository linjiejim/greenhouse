/**
 * WeCom (企业微信) SSO connector — corp self-built app (CorpApp).
 *
 * Authorize: browser gets the QR login page (wwlogin); the WeCom built-in
 * browser (UA contains "wxwork") gets the in-app OAuth flow instead, so
 * members inside the WeCom client sign in without scanning.
 *
 * Code exchange: gettoken (corp access_token, cached) → auth/getuserinfo
 * (code → userid; non-members returning openid are rejected) → best-effort
 * user/get enrichment (name/avatar need contacts permission — failures are
 * tolerated, the login itself never depends on them).
 *
 * Setup guide: README "Enterprise SSO"; spec docs/specs/20260708-sso-identity-connectors.md.
 */

import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { SsoConnector, SsoIdentity } from './types.js';

const QY_API = 'https://qyapi.weixin.qq.com/cgi-bin';
const TOKEN_SAFETY_MARGIN_MS = 5 * 60_000;

export interface WecomConfig {
  corpId: string;
  agentId: string;
  secret: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

interface WecomApiResult {
  errcode?: number;
  errmsg?: string;
  [key: string]: unknown;
}

export function createWecomConnector(cfg: WecomConfig): SsoConnector {
  const fetchFn = cfg.fetchFn ?? fetch;
  let tokenCache: { token: string; expiresAt: number } | null = null;

  async function qyGet(path: string, params: Record<string, string>): Promise<WecomApiResult> {
    const url = new URL(`${QY_API}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetchFn(url.toString());
    if (!res.ok) throw new Error(`WeCom API ${path} HTTP ${res.status}`);
    return (await res.json()) as WecomApiResult;
  }

  async function getCorpToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
    const data = await qyGet('gettoken', { corpid: cfg.corpId, corpsecret: cfg.secret });
    if (data.errcode !== 0 || typeof data.access_token !== 'string') {
      throw new Error(`WeCom gettoken failed: ${data.errcode} ${data.errmsg}`);
    }
    const ttlMs = (typeof data.expires_in === 'number' ? data.expires_in : 7200) * 1000;
    tokenCache = { token: data.access_token, expiresAt: Date.now() + ttlMs - TOKEN_SAFETY_MARGIN_MS };
    return tokenCache.token;
  }

  /** Call an authenticated endpoint, refreshing the corp token once on 40014/42001. */
  async function qyAuthedGet(path: string, params: Record<string, string>): Promise<WecomApiResult> {
    let data = await qyGet(path, { ...params, access_token: await getCorpToken() });
    if (data.errcode === 40014 || data.errcode === 42001) {
      data = await qyGet(path, { ...params, access_token: await getCorpToken(true) });
    }
    return data;
  }

  return {
    id: 'wecom',
    label: '企业微信',

    buildAuthorizeUrl({ redirectUri, state, userAgent }) {
      const inWecomClient = (userAgent ?? '').toLowerCase().includes('wxwork');
      if (inWecomClient) {
        // In-app silent OAuth — https://developer.work.weixin.qq.com/document/path/91022
        const q = new URLSearchParams({
          appid: cfg.corpId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'snsapi_base',
          state,
          agentid: cfg.agentId,
        });
        return `https://open.weixin.qq.com/connect/oauth2/authorize?${q.toString()}#wechat_redirect`;
      }
      // QR web login — https://developer.work.weixin.qq.com/document/path/98152
      const q = new URLSearchParams({
        login_type: 'CorpApp',
        appid: cfg.corpId,
        agentid: cfg.agentId,
        redirect_uri: redirectUri,
        state,
      });
      return `https://login.work.weixin.qq.com/wwlogin/sso/login?${q.toString()}`;
    },

    async exchangeCode({ code }): Promise<SsoIdentity> {
      const info = await qyAuthedGet('auth/getuserinfo', { code });
      if (info.errcode !== 0) {
        throw new Error(`WeCom getuserinfo failed: ${info.errcode} ${info.errmsg}`);
      }
      const userid = typeof info.userid === 'string' ? info.userid : undefined;
      if (!userid) {
        // Non-members come back as openid/external_userid — only corp members may log in.
        throw new Error('WeCom account is not a member of this corp');
      }

      const identity: SsoIdentity = { subject: userid, displayName: userid, raw: info };

      // Best-effort enrichment — needs contacts read permission, and WeCom's
      // privacy rules may still withhold the name. Never fail the login on it.
      try {
        const detail = await qyAuthedGet('user/get', { userid });
        if (detail.errcode === 0) {
          if (typeof detail.name === 'string' && detail.name) identity.displayName = detail.name;
          if (typeof detail.avatar === 'string' && detail.avatar) identity.avatarUrl = detail.avatar;
          const email = detail.biz_mail ?? detail.email;
          if (typeof email === 'string' && email) identity.email = email;
          identity.raw = { ...info, detail };
        }
      } catch (err) {
        logger.warn('[sso:wecom] user/get enrichment failed', { userid, error: toErrorMessage(err) });
      }

      return identity;
    },
  };
}
