/**
 * Feishu (飞书 / Lark) SSO connector — standard OAuth authorization code flow.
 *
 * Authorize: accounts.feishu.cn/open-apis/authen/v1/authorize (client_id +
 * redirect_uri + state) → callback code (5 min, single use).
 * Exchange: POST /open-apis/authen/v2/oauth/token (authorization_code) →
 * user_access_token → GET /open-apis/authen/v1/user_info.
 *
 * Subject = union_id (stable across apps in the tenant), falling back to
 * open_id. Set SSO_FEISHU_BASE_URL=https://open.larksuite.com for Lark
 * international tenants.
 *
 * Setup guide: README "Enterprise SSO"; spec docs/specs/20260708-sso-identity-connectors.md.
 */

import type { SsoConnector, SsoIdentity } from './types.js';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  /** Open-platform API base. Default https://open.feishu.cn; Lark: https://open.larksuite.com. */
  baseUrl?: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

export function createFeishuConnector(cfg: FeishuConfig): SsoConnector {
  const fetchFn = cfg.fetchFn ?? fetch;
  const baseUrl = (cfg.baseUrl ?? 'https://open.feishu.cn').replace(/\/+$/, '');
  // The authorize page lives on the accounts domain (accounts.feishu.cn /
  // accounts.larksuite.com); API calls stay on the open.* domain.
  const accountsBaseUrl = baseUrl.replace('//open.', '//accounts.');

  return {
    id: 'feishu',
    label: '飞书',

    buildAuthorizeUrl({ redirectUri, state }) {
      const q = new URLSearchParams({
        client_id: cfg.appId,
        redirect_uri: redirectUri,
        state,
      });
      return `${accountsBaseUrl}/open-apis/authen/v1/authorize?${q.toString()}`;
    },

    async exchangeCode({ code, redirectUri }): Promise<SsoIdentity> {
      const tokenRes = await fetchFn(`${baseUrl}/open-apis/authen/v2/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: cfg.appId,
          client_secret: cfg.appSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const tokenData = (await tokenRes.json().catch(() => ({}))) as {
        access_token?: string;
        code?: number;
        error?: string;
        error_description?: string;
      };
      if (!tokenRes.ok || !tokenData.access_token) {
        const detail = tokenData.error_description ?? tokenData.error ?? `code ${tokenData.code ?? tokenRes.status}`;
        throw new Error(`Feishu oauth/token failed: ${detail}`);
      }

      const infoRes = await fetchFn(`${baseUrl}/open-apis/authen/v1/user_info`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const infoData = (await infoRes.json().catch(() => ({}))) as {
        code?: number;
        msg?: string;
        data?: {
          union_id?: string;
          open_id?: string;
          name?: string;
          en_name?: string;
          avatar_url?: string;
          email?: string;
          enterprise_email?: string;
          user_id?: string;
        };
      };
      if (!infoRes.ok || infoData.code !== 0 || !infoData.data) {
        throw new Error(`Feishu user_info failed: ${infoData.code ?? infoRes.status} ${infoData.msg ?? ''}`.trim());
      }

      const u = infoData.data;
      const subject = u.union_id || u.open_id;
      if (!subject) throw new Error('Feishu user_info returned no union_id/open_id');

      return {
        subject,
        displayName: u.name || u.en_name || undefined,
        email: u.enterprise_email || u.email || undefined,
        avatarUrl: u.avatar_url || undefined,
        raw: u,
      };
    },
  };
}
