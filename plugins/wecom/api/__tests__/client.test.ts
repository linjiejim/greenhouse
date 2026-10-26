import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetWeComTokenCache, getWeComConfig, isWeComConfigured, sendAppMarkdown } from '../client.js';

const ENV_KEYS = ['WECOM_CORP_ID', 'WECOM_AGENT_ID', 'WECOM_APP_SECRET'] as const;
const saved: Record<string, string | undefined> = {};

function configure(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

const VALID = { WECOM_CORP_ID: 'corp', WECOM_AGENT_ID: '1000002', WECOM_APP_SECRET: 'secret' };

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  _resetWeComTokenCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
  _resetWeComTokenCache();
});

describe('getWeComConfig', () => {
  it('requires all three values, and a positive integer agent id', () => {
    configure(VALID);
    expect(getWeComConfig()).toEqual({ corpId: 'corp', agentId: 1000002, secret: 'secret' });

    configure({ ...VALID, WECOM_APP_SECRET: undefined });
    expect(getWeComConfig()).toBeNull();

    configure({ ...VALID, WECOM_AGENT_ID: 'not-a-number' });
    expect(getWeComConfig()).toBeNull();

    configure({ ...VALID, WECOM_AGENT_ID: '0' });
    expect(getWeComConfig()).toBeNull();
  });
});

describe('sendAppMarkdown', () => {
  it('reports "not configured" instead of pretending, when no app is set up', async () => {
    // The whole UI keys off this: an unconfigured deployment must show no WeCom
    // affordances rather than buttons that fail at use time.
    configure({});
    expect(isWeComConfigured()).toBe(false);
    expect(await sendAppMarkdown('someone', 'hi')).toEqual({
      ok: false,
      error: expect.stringContaining('not configured'),
    });
  });

  it('fetches a token once and reuses it across sends', async () => {
    configure(VALID);
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('gettoken')) {
          return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }));
        }
        return new Response(JSON.stringify({ errcode: 0 }));
      }),
    );

    expect(await sendAppMarkdown('u1', 'a')).toEqual({ ok: true });
    expect(await sendAppMarkdown('u2', 'b')).toEqual({ ok: true });

    // gettoken is rate-limited by WeCom; caching it is not an optimization.
    expect(calls.filter((u) => u.includes('gettoken'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('message/send'))).toHaveLength(2);
  });

  it('refreshes once when the cached token has been invalidated (42001)', async () => {
    configure(VALID);
    let sends = 0;
    const tokens: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('gettoken')) {
          const token = `tok${tokens.length}`;
          tokens.push(token);
          return new Response(JSON.stringify({ access_token: token, expires_in: 7200 }));
        }
        sends += 1;
        // First attempt: the cached token died early (secret reset elsewhere).
        return new Response(JSON.stringify(sends === 1 ? { errcode: 42001, errmsg: 'expired' } : { errcode: 0 }));
      }),
    );

    expect(await sendAppMarkdown('u1', 'a')).toEqual({ ok: true });
    expect(tokens).toHaveLength(2);
  });

  it('surfaces a WeCom error code rather than reporting success', async () => {
    configure(VALID);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('gettoken')
          ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }))
          : new Response(JSON.stringify({ errcode: 81013, errmsg: 'not in party' })),
      ),
    );

    expect(await sendAppMarkdown('stranger', 'hi')).toEqual({ ok: false, error: '81013 not in party' });
  });

  it('does not throw when the network is down', async () => {
    configure(VALID);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    // Delivery failure must never turn a successful run into a failed one.
    expect(await sendAppMarkdown('u1', 'a')).toEqual({ ok: false, error: 'WeCom request failed' });
  });
});
