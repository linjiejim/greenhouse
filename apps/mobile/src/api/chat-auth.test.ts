/**
 * The streaming chat path's auth (`openAuthed` in ./chat.ts, behind `openBotsChat` /
 * `streamChat` / `streamChatRun`) across a station switch — the same rule as `api()`
 * (./client.test.ts): a 401 that comes back after the active station changed is handed back
 * untouched, and a request is never resent after a switch (that would send the new station's
 * token, and the old station's request, to the old origin). Runs in the ROOT vitest unit
 * project: `expo/fetch`, the station registry and the token mirror are mocked; the refresh is
 * the real one (./client.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { base: 'https://a.example', sid: 'a', access: 'A-token' };
const setTokens = vi.fn((access: string) => {
  state.access = access;
});

vi.mock('../store/stations', () => ({ getApiBase: () => state.base }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('./token-storage', () => ({
  getAccessToken: () => state.access,
  getRefreshToken: () => `${state.sid}-refresh`,
  getTokenStationId: () => state.sid,
  setTokens: (access: string) => setTokens(access),
  setCachedUser: () => {},
  clearTokens: () => {},
}));

type Call = { url: string; auth: string | null };
let calls: Call[] = [];
let answer: (call: Call) => Promise<Response>;

const record = (url: string, init: { headers?: HeadersInit } = {}) => {
  const call = { url, auth: new Headers(init.headers).get('Authorization') };
  calls.push(call);
  return answer(call);
};
vi.mock('expo/fetch', () => ({ fetch: record }));

const { openBotsChat } = await import('./chat');

function switchTo(sid: string, base: string, access: string): void {
  Object.assign(state, { sid, base, access });
}

const status = (code: number) => new Response(code === 202 ? '{"queued":true}' : null, { status: code });
const send = () => openBotsChat({ sessionId: 'sess_1', content: 'hi' });

beforeEach(() => {
  switchTo('a', 'https://a.example', 'A-token');
  calls = [];
  setTokens.mockClear();
  answer = async () => status(202);
  vi.stubGlobal('fetch', record);
});

describe('openAuthed across a station switch', () => {
  it('refreshes and resends on the same station', async () => {
    answer = async (call) => {
      if (call.url.endsWith('/api/auth/refresh')) {
        return new Response(JSON.stringify({ accessToken: 'A2', refreshToken: 'r2' }), { status: 200 });
      }
      return call.auth === 'Bearer A2' ? status(202) : status(401);
    };
    expect(await send()).toEqual({ kind: 'queued' });
    expect(calls).toEqual([
      { url: 'https://a.example/api/chat', auth: 'Bearer A-token' },
      { url: 'https://a.example/api/auth/refresh', auth: null },
      { url: 'https://a.example/api/chat', auth: 'Bearer A2' },
    ]);
  });

  it('a 401 that comes back after a switch is handed back: no refresh, no resend', async () => {
    answer = async () => {
      switchTo('b', 'https://b.example', 'B-token');
      return status(401);
    };
    const result = await send();
    expect(result).toMatchObject({ kind: 'error', status: 401 });
    expect(calls).toEqual([{ url: 'https://a.example/api/chat', auth: 'Bearer A-token' }]);
    expect(setTokens).not.toHaveBeenCalled();
  });

  it('a switch during the refresh: the request is not resent (to either station)', async () => {
    answer = async (call) => {
      if (call.url.endsWith('/api/auth/refresh')) {
        switchTo('b', 'https://b.example', 'B-token');
        return new Response(JSON.stringify({ accessToken: 'A2', refreshToken: 'r2' }), { status: 200 });
      }
      return status(401);
    };
    const result = await send();
    expect(result).toMatchObject({ kind: 'error', status: 401 });
    expect(calls.filter((c) => c.url.endsWith('/api/chat'))).toEqual([
      { url: 'https://a.example/api/chat', auth: 'Bearer A-token' },
    ]);
    // A's rotation arrived after the switch: never written into B's slot.
    expect(setTokens).not.toHaveBeenCalled();
  });

  it('a switch right after a successful refresh: A\'s request is not resent to B', async () => {
    setTokens.mockImplementationOnce((access: string) => {
      state.access = access;
      // The member switches in the gap between the rotation landing and the resend.
      switchTo('b', 'https://b.example', 'B-token');
    });
    answer = async (call) => {
      if (call.url.endsWith('/api/auth/refresh')) {
        return new Response(JSON.stringify({ accessToken: 'A2', refreshToken: 'r2' }), { status: 200 });
      }
      return status(401);
    };
    const result = await send();
    expect(result).toMatchObject({ kind: 'error', status: 401 });
    expect(calls.filter((c) => c.url.endsWith('/api/chat'))).toEqual([
      { url: 'https://a.example/api/chat', auth: 'Bearer A-token' },
    ]);
  });
});
