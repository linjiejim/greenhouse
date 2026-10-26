import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetFeishuTokenCache,
  buildAuthorizeUrl,
  buildMarkdownCard,
  getFeishuConfig,
  isFeishuConfigured,
  resolveUserByCode,
  sendCardMarkdown,
} from '../client.js';

const ENV_KEYS = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'] as const;
const saved: Record<string, string | undefined> = {};

function configure(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

const VALID = { FEISHU_APP_ID: 'cli_app', FEISHU_APP_SECRET: 'secret' };

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  _resetFeishuTokenCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
  _resetFeishuTokenCache();
});

describe('getFeishuConfig', () => {
  it('requires both values', () => {
    configure(VALID);
    expect(getFeishuConfig()).toEqual({ appId: 'cli_app', appSecret: 'secret' });

    configure({ ...VALID, FEISHU_APP_SECRET: undefined });
    expect(getFeishuConfig()).toBeNull();

    configure({ FEISHU_APP_ID: '  ', FEISHU_APP_SECRET: 'secret' });
    expect(getFeishuConfig()).toBeNull();
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds the accounts.feishu.cn consent URL without leaking the secret', () => {
    const url = buildAuthorizeUrl(
      { appId: 'cli_app', appSecret: 'secret' },
      'https://greenhouse.example.test/api/feishu/oauth/callback',
      'state-1',
    );
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://accounts.feishu.cn');
    expect(parsed.searchParams.get('client_id')).toBe('cli_app');
    expect(parsed.searchParams.get('state')).toBe('state-1');
    expect(url).not.toContain('secret');
  });
});

describe('buildMarkdownCard', () => {
  it('emits card JSON 2.0 — 1.0 silently degrades headings and tables to literal text', () => {
    // Regression guard for the first real automation digest: on 1.0 the reader
    // got `## 数据口径说明` and raw `| col | col |` rows. Dropping back to
    // `{config, elements}` would reintroduce exactly that, and nothing would
    // fail — the API accepts both.
    expect(buildMarkdownCard('## Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')).toEqual({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: '## Title\n\n| a | b |\n| --- | --- |\n| 1 | 2 |' }] },
    });
  });

  it('carries no header — the title line already lives in the shared notification body', () => {
    const card = buildMarkdownCard('**✅ Daily report**\n\nbody') as { header?: unknown };
    expect(card.header).toBeUndefined();
  });
});

describe('sendCardMarkdown', () => {
  it('reports "not configured" instead of pretending, when no app is set up', async () => {
    // The whole UI keys off this: an unconfigured deployment must show no
    // Feishu affordances rather than buttons that fail at use time.
    configure({});
    expect(isFeishuConfigured()).toBe(false);
    expect(await sendCardMarkdown('ou-1', 'hi')).toEqual({
      ok: false,
      error: expect.stringContaining('not configured'),
    });
  });

  it('fetches a tenant token once and reuses it across sends', async () => {
    configure(VALID);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('tenant_access_token')) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }));
        }
        return new Response(JSON.stringify({ code: 0 }));
      }),
    );

    expect(await sendCardMarkdown('ou-1', 'a')).toEqual({ ok: true });
    expect(await sendCardMarkdown('ou-2', 'b')).toEqual({ ok: true });

    // The token endpoint is rate-limited by Feishu; caching is not an optimization.
    expect(calls.filter((u) => u.includes('tenant_access_token'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('im/v1/messages'))).toHaveLength(2);
  });

  it('refreshes once when the cached token has been invalidated (99991663)', async () => {
    configure(VALID);
    let sends = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('tenant_access_token')) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: `tok-${Date.now()}`, expire: 7200 }));
        }
        sends += 1;
        // First send hits a token the tenant admin just rotated away.
        if (sends === 1) return new Response(JSON.stringify({ code: 99991663, msg: 'token invalid' }));
        return new Response(JSON.stringify({ code: 0 }));
      }),
    );

    expect(await sendCardMarkdown('ou-1', 'a')).toEqual({ ok: true });
    expect(sends).toBe(2);
  });

  it('surfaces the upstream error code instead of a silent failure', async () => {
    configure(VALID);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('tenant_access_token')) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok', expire: 7200 }));
        }
        return new Response(JSON.stringify({ code: 230002, msg: 'user not visible to app' }));
      }),
    );

    expect(await sendCardMarkdown('ou-1', 'a')).toEqual({ ok: false, error: '230002 user not visible to app' });
  });
});

describe('resolveUserByCode', () => {
  const config = { appId: 'cli_app', appSecret: 'secret' };
  const redirect = 'https://greenhouse.example.test/api/feishu/oauth/callback';

  it('exchanges code → user token → open_id, passing the registered redirect verbatim', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('authen/v2/oauth/token')) {
          bodies.push(String(init?.body));
          return new Response(JSON.stringify({ code: 0, access_token: 'user-tok' }));
        }
        return new Response(JSON.stringify({ code: 0, data: { open_id: 'ou-123', name: 'Jim' } }));
      }),
    );

    expect(await resolveUserByCode(config, 'the-code', redirect)).toEqual({ openId: 'ou-123', name: 'Jim' });
    // Feishu validates redirect_uri on exchange too — it must match registration.
    expect(bodies[0]).toContain(redirect);
  });

  it('returns null (never a partial identity) when the exchange fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 20063, msg: 'bad code' }))),
    );
    expect(await resolveUserByCode(config, 'bad', redirect)).toBeNull();
  });
});
