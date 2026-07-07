/**
 * WeCom / Feishu connector unit tests — authorize URL construction and code
 * exchange against a stubbed fetch (no network).
 */

import { describe, it, expect } from 'vitest';

process.env.ACCESS_PASSWORD = 'test-secret-password-123';
process.env.TOKEN_SIGNING_KEY = 'dedicated-signing-key-for-tests-xyz';

import { createWecomConnector } from '../../apps/api/src/auth/sso/wecom.js';
import { createFeishuConnector } from '../../apps/api/src/auth/sso/feishu.js';

/** Sequential fetch stub: routes each request by URL substring, records calls. */
function fetchStub(routes: Array<{ match: string; reply: unknown | ((url: string) => unknown) }>) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    for (const route of routes) {
      if (url.includes(route.match)) {
        const body = typeof route.reply === 'function' ? (route.reply as (u: string) => unknown)(url) : route.reply;
        return { ok: true, status: 200, json: async () => body } as Response;
      }
    }
    throw new Error(`fetchStub: no route for ${url}`);
  }) as typeof fetch;
  return { fn, calls };
}

describe('WeCom connector', () => {
  const cfg = { corpId: 'ww_corp', agentId: '1000007', secret: 'sec' };

  it('builds the QR wwlogin URL for regular browsers', () => {
    const connector = createWecomConnector(cfg);
    const url = new URL(
      connector.buildAuthorizeUrl({ redirectUri: 'https://gh.example.com/api/auth/sso/wecom/callback', state: 'st1' }),
    );
    expect(url.origin + url.pathname).toBe('https://login.work.weixin.qq.com/wwlogin/sso/login');
    expect(url.searchParams.get('login_type')).toBe('CorpApp');
    expect(url.searchParams.get('appid')).toBe('ww_corp');
    expect(url.searchParams.get('agentid')).toBe('1000007');
    expect(url.searchParams.get('redirect_uri')).toBe('https://gh.example.com/api/auth/sso/wecom/callback');
    expect(url.searchParams.get('state')).toBe('st1');
  });

  it('builds the in-app OAuth URL inside the WeCom client', () => {
    const connector = createWecomConnector(cfg);
    const raw = connector.buildAuthorizeUrl({
      redirectUri: 'https://gh.example.com/api/auth/sso/wecom/callback',
      state: 'st2',
      userAgent: 'Mozilla/5.0 ... wxwork/4.1.10',
    });
    expect(raw.startsWith('https://open.weixin.qq.com/connect/oauth2/authorize?')).toBe(true);
    expect(raw.endsWith('#wechat_redirect')).toBe(true);
    const url = new URL(raw);
    expect(url.searchParams.get('appid')).toBe('ww_corp');
    expect(url.searchParams.get('scope')).toBe('snsapi_base');
    expect(url.searchParams.get('agentid')).toBe('1000007');
  });

  it('exchanges a member code and enriches from user/get', async () => {
    const { fn, calls } = fetchStub([
      { match: '/gettoken', reply: { errcode: 0, access_token: 'T1', expires_in: 7200 } },
      { match: '/auth/getuserinfo', reply: { errcode: 0, userid: 'zhangsan' } },
      {
        match: '/user/get',
        reply: { errcode: 0, name: '张三', avatar: 'https://a.example/z.png', biz_mail: 'zs@corp.example' },
      },
    ]);
    const connector = createWecomConnector({ ...cfg, fetchFn: fn });
    const identity = await connector.exchangeCode({ code: 'CODE1', redirectUri: 'unused' });

    expect(identity.subject).toBe('zhangsan');
    expect(identity.displayName).toBe('张三');
    expect(identity.email).toBe('zs@corp.example');
    expect(identity.avatarUrl).toBe('https://a.example/z.png');
    // gettoken is called once and cached for the enrichment call.
    expect(calls.filter((u) => u.includes('/gettoken')).length).toBe(1);
  });

  it('rejects non-members (openid instead of userid)', async () => {
    const { fn } = fetchStub([
      { match: '/gettoken', reply: { errcode: 0, access_token: 'T1', expires_in: 7200 } },
      { match: '/auth/getuserinfo', reply: { errcode: 0, openid: 'oABC' } },
    ]);
    const connector = createWecomConnector({ ...cfg, fetchFn: fn });
    await expect(connector.exchangeCode({ code: 'C', redirectUri: 'u' })).rejects.toThrow(/not a member/);
  });

  it('retries once with a fresh corp token on 42001', async () => {
    let userinfoCalls = 0;
    let tokenCalls = 0;
    const { fn } = fetchStub([
      {
        match: '/gettoken',
        reply: () => {
          tokenCalls += 1;
          return { errcode: 0, access_token: `T${tokenCalls}`, expires_in: 7200 };
        },
      },
      {
        match: '/auth/getuserinfo',
        reply: () => {
          userinfoCalls += 1;
          return userinfoCalls === 1 ? { errcode: 42001, errmsg: 'expired' } : { errcode: 0, userid: 'lisi' };
        },
      },
      { match: '/user/get', reply: { errcode: 60011, errmsg: 'no privilege' } },
    ]);
    const connector = createWecomConnector({ ...cfg, fetchFn: fn });
    const identity = await connector.exchangeCode({ code: 'C', redirectUri: 'u' });
    expect(identity.subject).toBe('lisi');
    expect(tokenCalls).toBe(2);
    // Enrichment was denied (60011) — the login still succeeds with userid as name.
    expect(identity.displayName).toBe('lisi');
  });

  it('surfaces getuserinfo failures', async () => {
    const { fn } = fetchStub([
      { match: '/gettoken', reply: { errcode: 0, access_token: 'T1', expires_in: 7200 } },
      { match: '/auth/getuserinfo', reply: { errcode: 40029, errmsg: 'invalid code' } },
    ]);
    const connector = createWecomConnector({ ...cfg, fetchFn: fn });
    await expect(connector.exchangeCode({ code: 'BAD', redirectUri: 'u' })).rejects.toThrow(/40029/);
  });
});

describe('Feishu connector', () => {
  const cfg = { appId: 'cli_app', appSecret: 'sec' };

  it('builds the authorize URL on the accounts domain', () => {
    const connector = createFeishuConnector(cfg);
    const url = new URL(
      connector.buildAuthorizeUrl({ redirectUri: 'https://gh.example.com/api/auth/sso/feishu/callback', state: 's' }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    expect(url.searchParams.get('client_id')).toBe('cli_app');
    expect(url.searchParams.get('redirect_uri')).toBe('https://gh.example.com/api/auth/sso/feishu/callback');
    expect(url.searchParams.get('state')).toBe('s');
  });

  it('honors SSO_FEISHU_BASE_URL for Lark international', () => {
    const connector = createFeishuConnector({ ...cfg, baseUrl: 'https://open.larksuite.com' });
    const url = connector.buildAuthorizeUrl({ redirectUri: 'https://x/cb', state: 's' });
    expect(url.startsWith('https://accounts.larksuite.com/open-apis/authen/v1/authorize?')).toBe(true);
  });

  it('exchanges a code for a union_id-keyed identity', async () => {
    const { fn, calls } = fetchStub([
      { match: '/authen/v2/oauth/token', reply: { code: 0, access_token: 'u-token', expires_in: 7200 } },
      {
        match: '/authen/v1/user_info',
        reply: {
          code: 0,
          data: {
            union_id: 'on_union1',
            open_id: 'ou_open1',
            name: '李雷',
            avatar_url: 'https://a.example/l.png',
            enterprise_email: 'lilei@corp.example',
          },
        },
      },
    ]);
    const connector = createFeishuConnector({ ...cfg, fetchFn: fn });
    const identity = await connector.exchangeCode({ code: 'C', redirectUri: 'https://x/cb' });

    expect(identity.subject).toBe('on_union1');
    expect(identity.displayName).toBe('李雷');
    expect(identity.email).toBe('lilei@corp.example');
    expect(calls[0]).toContain('open.feishu.cn'); // API stays on the open domain
  });

  it('falls back to open_id when union_id is absent', async () => {
    const { fn } = fetchStub([
      { match: '/authen/v2/oauth/token', reply: { access_token: 'u-token' } },
      { match: '/authen/v1/user_info', reply: { code: 0, data: { open_id: 'ou_only', name: 'X' } } },
    ]);
    const connector = createFeishuConnector({ ...cfg, fetchFn: fn });
    const identity = await connector.exchangeCode({ code: 'C', redirectUri: 'u' });
    expect(identity.subject).toBe('ou_only');
  });

  it('surfaces token endpoint failures', async () => {
    const { fn } = fetchStub([
      { match: '/authen/v2/oauth/token', reply: { code: 20063, error_description: 'code expired' } },
    ]);
    const connector = createFeishuConnector({ ...cfg, fetchFn: fn });
    await expect(connector.exchangeCode({ code: 'OLD', redirectUri: 'u' })).rejects.toThrow(/code expired/);
  });
});
