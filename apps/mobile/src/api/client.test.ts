/**
 * api() (./client.ts) across a station switch: a 401 that comes back after the active station
 * changed belongs to the previous station — it must not refresh, retry (that would send the new
 * station's token to the old origin) or sign the new station out; a refresh is shared only by
 * callers on the station it was started for; and the token only goes to the active station's
 * origin. Runs in the ROOT vitest unit project with the station registry and the token mirror
 * mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { base: 'https://a.example', sid: 'a', access: 'A-token' };
const clearTokens = vi.fn();
const setTokens = vi.fn();

vi.mock('../store/stations', () => ({ getApiBase: () => state.base }));
vi.mock('./token-storage', () => ({
  getAccessToken: () => state.access,
  getRefreshToken: () => `${state.sid}-refresh`,
  getTokenStationId: () => state.sid,
  setTokens: (...args: unknown[]) => setTokens(...args),
  setCachedUser: () => {},
  clearTokens: () => clearTokens(),
}));

const { api, onStation, setOnUnauthorized } = await import('./client');

type Call = { url: string; auth: string | null };
let calls: Call[] = [];
let answer: (call: Call) => Promise<Response>;

function switchTo(sid: string, base: string, access: string): void {
  Object.assign(state, { sid, base, access });
}

const status = (code: number) => new Response(code === 200 ? '{}' : null, { status: code });
const rotated = (access: string, refresh: string) =>
  new Response(JSON.stringify({ accessToken: access, refreshToken: refresh }), { status: 200 });
const refreshCalls = () => calls.filter((c) => c.url.endsWith('/api/auth/refresh')).map((c) => c.url);
/** Let every settled promise's continuation run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  switchTo('a', 'https://a.example', 'A-token');
  calls = [];
  clearTokens.mockReset();
  setTokens.mockReset();
  answer = async () => status(200);
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const call = { url, auth: new Headers(init.headers).get('Authorization') };
    calls.push(call);
    return answer(call);
  });
});

describe('api() 401 handling', () => {
  it('refreshes and retries on the same station', async () => {
    let first = true;
    answer = async (call) => {
      if (call.url.endsWith('/api/auth/refresh')) {
        return new Response(JSON.stringify({ accessToken: 'A2', refreshToken: 'r2' }), { status: 200 });
      }
      if (first) {
        first = false;
        return status(401);
      }
      return status(200);
    };
    setTokens.mockImplementation((access: string) => (state.access = access));
    const res = await api('/api/x');
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      'https://a.example/api/x',
      'https://a.example/api/auth/refresh',
      'https://a.example/api/x',
    ]);
    expect(calls[2]?.auth).toBe('Bearer A2');
  });

  it('a 401 from the old station after a switch is handed back untouched', async () => {
    const unauthorized = vi.fn();
    setOnUnauthorized(unauthorized);
    answer = async () => {
      // The member switched to station B while A's request was out.
      switchTo('b', 'https://b.example', 'B-token');
      return status(401);
    };
    const res = await api('/api/x');
    expect(res.status).toBe(401);
    expect(calls).toEqual([{ url: 'https://a.example/api/x', auth: 'Bearer A-token' }]);
    expect(clearTokens).not.toHaveBeenCalled();
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('a switch during the refresh neither retries to the old origin nor signs out', async () => {
    const unauthorized = vi.fn();
    setOnUnauthorized(unauthorized);
    answer = async (call) => {
      if (call.url.endsWith('/api/auth/refresh')) {
        switchTo('b', 'https://b.example', 'B-token');
        return status(500);
      }
      return status(401);
    };
    const res = await api('/api/x');
    expect(res.status).toBe(401);
    expect(calls.some((c) => c.url.startsWith('https://a.') && c.auth === 'Bearer B-token')).toBe(false);
    expect(calls.filter((c) => c.url === 'https://a.example/api/x')).toHaveLength(1);
    expect(clearTokens).not.toHaveBeenCalled();
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('a 401 that survives the refresh on the same station signs out', async () => {
    const unauthorized = vi.fn();
    setOnUnauthorized(unauthorized);
    answer = async () => status(401);
    const res = await api('/api/x');
    expect(res.status).toBe(401);
    expect(clearTokens).toHaveBeenCalledTimes(1);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
});

describe('refresh sharing across stations', () => {
  it("a 401 on the new station never joins the old station's refresh (and is not signed out by it)", async () => {
    const unauthorized = vi.fn();
    setOnUnauthorized(unauthorized);
    setTokens.mockImplementation((access: string) => (state.access = access));
    let releaseA!: () => void;
    answer = async (call) => {
      if (call.url === 'https://a.example/api/auth/refresh') {
        // A's refresh is still out when the member switches to B.
        await new Promise<void>((resolve) => (releaseA = resolve));
        return rotated('A2', 'a-r2');
      }
      if (call.url === 'https://b.example/api/auth/refresh') return rotated('B2', 'b-r2');
      return call.auth === 'Bearer B2' ? status(200) : status(401);
    };

    const onA = api('/api/a');
    await flush();
    expect(refreshCalls()).toEqual(['https://a.example/api/auth/refresh']);
    switchTo('b', 'https://b.example', 'B-token');
    const onB = api('/api/b');
    await flush();
    releaseA();
    const [resA, resB] = await Promise.all([onA, onB]);

    // B refreshed on its own and went through; A's late answer was dropped, A's 401 handed back.
    expect(refreshCalls()).toEqual(['https://a.example/api/auth/refresh', 'https://b.example/api/auth/refresh']);
    expect(resB.status).toBe(200);
    expect(resA.status).toBe(401);
    expect(setTokens.mock.calls).toEqual([['B2', 'b-r2']]);
    expect(clearTokens).not.toHaveBeenCalled();
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('concurrent 401s on one station share one refresh', async () => {
    setTokens.mockImplementation((access: string) => (state.access = access));
    let releaseRefresh!: () => void;
    answer = async (call) => {
      if (call.url.endsWith('/api/auth/refresh')) {
        await new Promise<void>((resolve) => (releaseRefresh = resolve));
        return rotated('A2', 'a-r2');
      }
      return call.auth === 'Bearer A2' ? status(200) : status(401);
    };
    const first = api('/api/one');
    const second = api('/api/two');
    await flush();
    releaseRefresh();
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(refreshCalls()).toHaveLength(1);
  });

  it("back on the first station, a caller joins that station's own refresh still in flight", async () => {
    setTokens.mockImplementation((access: string) => (state.access = access));
    let releaseA!: () => void;
    answer = async (call) => {
      if (call.url === 'https://a.example/api/auth/refresh') {
        await new Promise<void>((resolve) => (releaseA = resolve));
        return rotated('A2', 'a-r2');
      }
      return call.auth === 'Bearer A2' ? status(200) : status(401);
    };
    const before = api('/api/a');
    await flush();
    switchTo('b', 'https://b.example', 'B-token');
    switchTo('a', 'https://a.example', 'A-token');
    const after = api('/api/a2');
    await flush();
    releaseA();
    const results = await Promise.all([before, after]);
    // One refresh for A (its refresh token rotates once); both callers retried with its answer.
    expect(refreshCalls()).toEqual(['https://a.example/api/auth/refresh']);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
  });
});

describe('the token only goes to the active station', () => {
  it('an absolute URL on another origin is fetched bare, and its 401 refreshes nothing', async () => {
    const unauthorized = vi.fn();
    setOnUnauthorized(unauthorized);
    answer = async () => status(401);
    const res = await api('https://elsewhere.example/api/x');
    expect(res.status).toBe(401);
    expect(calls).toEqual([{ url: 'https://elsewhere.example/api/x', auth: null }]);
    expect(clearTokens).not.toHaveBeenCalled();
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it("a path that turns the station into userinfo (`@host`) doesn't carry the token", async () => {
    answer = async () => status(200);
    await api('@evil.example/api/x');
    expect(calls).toEqual([{ url: 'https://a.example@evil.example/api/x', auth: null }]);
  });

  it("an absolute URL on the station's own origin is authenticated", async () => {
    await api('https://A.example/api/x');
    expect(calls).toEqual([{ url: 'https://A.example/api/x', auth: 'Bearer A-token' }]);
  });

  it('onStation compares parsed origins', () => {
    const base = 'https://a.example';
    expect(onStation('https://a.example/api/x', base)).toBe(true);
    expect(onStation('https://a.example:443/api/x', base)).toBe(true);
    expect(onStation('http://a.example/api/x', base)).toBe(false);
    expect(onStation('https://a.example.evil/api/x', base)).toBe(false);
    expect(onStation('https://a.example@evil.example/x', base)).toBe(false);
    expect(onStation('not a url', base)).toBe(false);
    expect(onStation('https://a.example/x', 'not a base')).toBe(false);
  });
});
