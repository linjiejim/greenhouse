import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, createApiClient, filenameOf, type TokenStore } from '../client.js';
import type { TokenPair } from '../auth.js';

const pair = (n: number): TokenPair => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_in: 900,
});

function memoryStore(initial: TokenPair | null): TokenStore & { value: TokenPair | null } {
  return {
    value: initial,
    get() {
      return this.value;
    },
    set(tokens) {
      this.value = tokens;
    },
  };
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('the API client', () => {
  it('sends the access token and parses the body', async () => {
    const fetch = vi.fn(async () => json(200, { id: 'mem_1' }));
    const client = createApiClient({ baseUrl: 'https://gh.test', tokens: memoryStore(pair(1)), fetch });
    expect(await client.me.get()).toEqual({ id: 'mem_1' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gh.test/api/me');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer access-1');
  });

  it('turns the error envelope into ApiClientError', async () => {
    const fetch = vi.fn(async () =>
      json(409, { error: { code: 'name_taken', message: 'Taken.', details: { name: 'x' } } }),
    );
    const client = createApiClient({ baseUrl: '', tokens: memoryStore(pair(1)), fetch });
    const error = await client.agents.create({ name: 'x' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status: 409, code: 'name_taken', message: 'Taken.', details: { name: 'x' } });
  });

  it('refreshes once for many expired requests, then retries each', async () => {
    const tokens = memoryStore(pair(1));
    let refreshes = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/api/auth/refresh')) {
        refreshes += 1;
        expect(JSON.parse(String(init!.body))).toEqual({ refresh_token: 'refresh-1' });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return json(200, pair(2));
      }
      const auth = (init!.headers as Record<string, string>).authorization;
      return auth === 'Bearer access-2'
        ? json(200, { path })
        : json(401, { error: { code: 'unauthorized', message: 'Expired.' } });
    });
    const client = createApiClient({ baseUrl: '', tokens, fetch });
    const results = await Promise.all([client.me.get(), client.agents.list(), client.notifications.summary()]);
    expect(refreshes).toBe(1);
    expect(results.map((result) => (result as unknown as { path: string }).path)).toEqual([
      '/api/me',
      '/api/agents?scope=mine',
      '/api/notifications/summary',
    ]);
    expect(tokens.value).toEqual(pair(2));
  });

  it('ends the session when the refresh is refused', async () => {
    const tokens = memoryStore(pair(1));
    const onSignedOut = vi.fn();
    const fetch = vi.fn(async (url: string | URL | Request) =>
      json(401, {
        error: { code: 'unauthorized', message: String(url).endsWith('/refresh') ? 'Revoked.' : 'Expired.' },
      }),
    );
    const client = createApiClient({ baseUrl: '', tokens, fetch, onSignedOut });
    await expect(client.me.get()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(tokens.value).toBeNull();
    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  it('keeps the session when the refresh fails on the network', async () => {
    const tokens = memoryStore(pair(1));
    const onSignedOut = vi.fn();
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/refresh')) throw new TypeError('network down');
      return json(401, { error: { code: 'unauthorized', message: 'Expired.' } });
    });
    const client = createApiClient({ baseUrl: '', tokens, fetch, onSignedOut });
    await expect(client.me.get()).rejects.toMatchObject({ status: 401 });
    expect(tokens.value).toEqual(pair(1));
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('builds query strings without empty values', async () => {
    const fetch = vi.fn(async () => json(200, { items: [], next_cursor: null }));
    const client = createApiClient({ baseUrl: '', tokens: memoryStore(pair(1)), fetch });
    await client.conversations.list({ kind: 'chat', q: 'tea leaves', archived: false });
    await client.notifications.list({ unread: true });
    expect(fetch.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual([
      '/api/conversations?kind=chat&q=tea+leaves',
      '/api/notifications?unread=true',
    ]);
  });

  it('signs in, stores the pair, and signs out locally even if the server is unreachable', async () => {
    const tokens = memoryStore(null);
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/logout')) throw new TypeError('offline');
      expect(JSON.parse(String(init!.body))).toEqual({ email: 'lin@example.com', password: 'pw', client: 'web' });
      return json(200, pair(7));
    });
    const client = createApiClient({ baseUrl: '', tokens, fetch });
    await client.auth.login('lin@example.com', 'pw');
    expect(tokens.value).toEqual(pair(7));
    await client.auth.logout();
    expect(tokens.value).toBeNull();
  });

  it('returns nothing for 204', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createApiClient({ baseUrl: '', tokens: memoryStore(pair(1)), fetch });
    expect(await client.conversations.stop('cnv_1')).toBeUndefined();
  });

  it('sends search kinds and the directory filter as query parameters', async () => {
    const fetch = vi.fn(async () => json(200, { items: [] }));
    const client = createApiClient({ baseUrl: '', tokens: memoryStore(pair(1)), fetch });
    await client.search({ q: 'kyoto', kinds: ['messages', 'agents'], limit: 3 });
    await client.members.directory('mei');
    await client.members.directory();
    expect(fetch.mock.calls.map((call) => (call as unknown as [string])[0])).toEqual([
      '/api/search?q=kyoto&kinds=messages%2Cagents&limit=3',
      '/api/members?q=mei',
      '/api/members',
    ]);
  });

  it('downloads an export with its file name, refreshing like any request, and reports errors the same way', async () => {
    const tokens = memoryStore(pair(1));
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/api/auth/refresh')) return json(200, pair(2));
      if ((init!.headers as Record<string, string>).authorization !== 'Bearer access-2') {
        return json(401, { error: { code: 'unauthorized', message: 'Expired.' } });
      }
      if (path.includes('cnv_gone')) return json(404, { error: { code: 'not_found', message: 'Gone.' } });
      return new Response('# 京都\n', {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="__.md"; filename*=UTF-8''${encodeURIComponent('京都.md')}`,
        },
      });
    });
    const client = createApiClient({ baseUrl: '', tokens, fetch });
    expect(await client.conversations.export('cnv_1')).toEqual({ filename: '京都.md', markdown: '# 京都\n' });
    await expect(client.conversations.export('cnv_gone')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('reads the file name of a download', () => {
    expect(filenameOf('attachment; filename="plain.md"')).toBe('plain.md');
    expect(filenameOf(`attachment; filename="_.md"; filename*=UTF-8''%E5%AF%B9%E8%AF%9D.md`)).toBe('对话.md');
    expect(filenameOf(`attachment; filename*=UTF-8''%E0%A4%A`)).toBe('download');
    expect(filenameOf(null, 'conversation.md')).toBe('conversation.md');
  });
});

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: unknown[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closedWith = code;
    this.onclose?.({ code });
  }
  push(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const ready = { type: 'ready', data: { member_id: 'mem_1' } };
const socketOptions = { WebSocket: FakeSocket as unknown as typeof WebSocket, minDelayMs: 1, maxDelayMs: 1 };

describe('the realtime socket', () => {
  it('says hello, delivers events, and reconnects after a drop', async () => {
    FakeSocket.all = [];
    const events: unknown[] = [];
    const readies: boolean[] = [];
    const client = createApiClient({ baseUrl: 'https://gh.test', tokens: memoryStore(pair(1)), fetch: vi.fn() });
    const connection = client.connect(
      { onEvent: (event) => events.push(event), onReady: ({ reconnected }) => readies.push(reconnected) },
      socketOptions,
    );
    await vi.waitFor(() => expect(FakeSocket.all[0]?.sent).toEqual([{ type: 'hello', data: { token: 'access-1' } }]));
    expect(FakeSocket.all[0]!.url).toBe('wss://gh.test/api/ws');
    FakeSocket.all[0]!.push(ready);
    const delta = { type: 'message.delta', data: { conversation_id: 'c', message_id: 'm', text: 'hi' } };
    FakeSocket.all[0]!.push(delta);
    expect(events).toEqual([delta]);

    FakeSocket.all[0]!.close(1006);
    await vi.waitFor(() => expect(FakeSocket.all[1]?.sent).toHaveLength(1));
    FakeSocket.all[1]!.push(ready);
    expect(readies).toEqual([false, true]);

    connection.close();
    expect(FakeSocket.all[1]!.closedWith).toBe(1000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('refreshes and reconnects when told to sign in again', async () => {
    FakeSocket.all = [];
    const tokens = memoryStore(pair(1));
    const fetch = vi.fn(async () => json(200, pair(2)));
    const client = createApiClient({ baseUrl: 'http://localhost:3000', tokens, fetch });
    client.connect({ onEvent: () => undefined }, socketOptions);
    await vi.waitFor(() => expect(FakeSocket.all[0]?.sent).toHaveLength(1));
    expect(FakeSocket.all[0]!.url).toBe('ws://localhost:3000/api/ws');
    FakeSocket.all[0]!.close(4401);
    await vi.waitFor(() => expect(FakeSocket.all[1]?.sent).toEqual([{ type: 'hello', data: { token: 'access-2' } }]));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('stops when the refresh is refused', async () => {
    FakeSocket.all = [];
    const tokens = memoryStore(pair(1));
    const onSignedOut = vi.fn();
    const statuses: string[] = [];
    const fetch = vi.fn(async () => json(401, { error: { code: 'unauthorized', message: 'Revoked.' } }));
    const client = createApiClient({ baseUrl: 'https://gh.test', tokens, fetch, onSignedOut });
    client.connect({ onEvent: () => undefined, onStatus: (status) => statuses.push(status) }, socketOptions);
    await vi.waitFor(() => expect(FakeSocket.all[0]?.sent).toHaveLength(1));
    FakeSocket.all[0]!.close(4401);
    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(FakeSocket.all).toHaveLength(1);
    expect(statuses.at(-1)).toBe('closed');
  });

  it('uses the pair another tab already refreshed instead of spending the refresh token again', async () => {
    const tokens = memoryStore(pair(1));
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/refresh')) throw new Error('should not refresh');
      const auth = (init!.headers as Record<string, string>).authorization;
      if (auth === 'Bearer access-1') {
        tokens.value = pair(2); // another tab rotated the pair meanwhile
        return json(401, { error: { code: 'unauthorized', message: 'Expired.' } });
      }
      return json(200, { ok: true });
    });
    const client = createApiClient({ baseUrl: '', tokens, fetch });
    expect(await client.me.get()).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the session when the server is busy', async () => {
    const tokens = memoryStore(pair(1));
    const onSignedOut = vi.fn();
    const fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/refresh')
        ? new Response('<html>bad gateway</html>', { status: 502 })
        : json(401, { error: { code: 'unauthorized', message: 'Expired.' } }),
    );
    const client = createApiClient({ baseUrl: '', tokens, fetch, onSignedOut });
    await expect(client.me.get()).rejects.toMatchObject({ status: 401 });
    expect(tokens.value).toEqual(pair(1));
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('reports a non-JSON failure as unavailable', async () => {
    const fetch = vi.fn(
      async () => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const client = createApiClient({ baseUrl: '', tokens: memoryStore(pair(1)), fetch });
    await expect(client.me.get()).rejects.toMatchObject({ status: 502, code: 'unavailable', message: 'Bad Gateway' });
  });

  it("reaches an Agent's computer: socket URLs with a fresh ticket, and files by their path in the home", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/computer/ticket')) {
        return json(200, { ticket: `t-${JSON.parse(String(init!.body)).purpose}`, expires_at: 'soon' });
      }
      if (path.includes('/computer/files/content')) {
        return new Response('bytes', {
          headers: { 'content-disposition': `attachment; filename="a.txt"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt` },
        });
      }
      return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : json(201, { name: 'a.txt' });
    });
    const client = createApiClient({ baseUrl: 'https://gh.test', tokens: memoryStore(pair(1)), fetch });
    expect(await client.agents.computerSocket('agt_1', 'control')).toBe(
      'wss://gh.test/api/ws/computer?ticket=t-control',
    );
    expect(await client.agents.computerSocket('agt_1', 'terminal')).toBe(
      'wss://gh.test/api/ws/computer-terminal?ticket=t-terminal',
    );

    const file = await client.agents.file('agt_1', 'work/报告.txt');
    expect(file.filename).toBe('报告.txt');
    expect(await file.blob.text()).toBe('bytes');
    await client.agents.uploadFile('agt_1', 'work', new File(['x'], 'a.txt'));
    await client.agents.removeFile('agt_1', 'work/a.txt');
    const calls = fetch.mock.calls.map(([url, init]) => [init?.method, String(url)]);
    expect(calls.slice(2)).toEqual([
      ['GET', 'https://gh.test/api/agents/agt_1/computer/files/content?path=work%2F%E6%8A%A5%E5%91%8A.txt'],
      ['POST', 'https://gh.test/api/agents/agt_1/computer/files?path=work'],
      ['DELETE', 'https://gh.test/api/agents/agt_1/computer/files?path=work%2Fa.txt'],
    ]);
    expect(fetch.mock.calls[3]![1]!.body).toBeInstanceOf(FormData);
  });
});
