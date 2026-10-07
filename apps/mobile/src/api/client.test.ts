/**
 * api() (./client.ts) across a station switch: a 401 that comes back after the active station
 * changed belongs to the previous station — it must not refresh, retry (that would send the new
 * station's token to the old origin) or sign the new station out. Runs in the ROOT vitest unit
 * project with the station registry and the token mirror mocked.
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

const { api, setOnUnauthorized } = await import('./client');

type Call = { url: string; auth: string | null };
let calls: Call[] = [];
let answer: (call: Call) => Promise<Response>;

function switchTo(sid: string, base: string, access: string): void {
  Object.assign(state, { sid, base, access });
}

const status = (code: number) => new Response(code === 200 ? '{}' : null, { status: code });

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
