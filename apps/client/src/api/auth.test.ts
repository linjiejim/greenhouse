/**
 * Sign-in (./auth.ts) across a station switch: the member lookup that follows the token pair may
 * answer after another station became active — then the mirror holds that station's tokens and
 * must not be cleared. Runs in the ROOT vitest unit project with the client, the token mirror and
 * the station registry mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = { sid: 'a' as string | null };
const clearTokens = vi.fn();
const setTokens = vi.fn();
const setCachedUser = vi.fn();
let meAnswer: () => Promise<Response>;

vi.mock('../store/stations', () => ({ getApiBase: () => 'https://a.example' }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
vi.mock('./token-storage', () => ({
  clearTokens: () => clearTokens(),
  setTokens: (...args: unknown[]) => setTokens(...args),
  setCachedUser: (...args: unknown[]) => setCachedUser(...args),
  getTokenStationId: () => state.sid,
  getAccessToken: () => 'token',
  getCachedUser: () => null,
}));
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return { ...actual, api: () => meAnswer() };
});

const { login } = await import('./auth');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const member = { user: { id: 'u1', email: 'a@b.c', nickname: 'Ann', role: 'team', locale: 'en', features: {} } };

beforeEach(() => {
  state.sid = 'a';
  clearTokens.mockReset();
  setTokens.mockReset();
  setCachedUser.mockReset();
  vi.stubGlobal('fetch', async () => json({ accessToken: 'A', refreshToken: 'R', user: member.user }));
});

describe('login', () => {
  it('signs in and caches the member', async () => {
    meAnswer = async () => json(member);
    expect(await login('a@b.c', 'pw')).toMatchObject({ ok: true, user: { id: 'u1' } });
    expect(setTokens).toHaveBeenCalledWith('A', 'R');
    expect(clearTokens).not.toHaveBeenCalled();
  });

  it('clears its own pair when the member lookup fails on the same station', async () => {
    meAnswer = async () => json({ error: 'Account not found' }, 401);
    expect(await login('a@b.c', 'pw')).toMatchObject({ ok: false });
    expect(clearTokens).toHaveBeenCalledOnce();
  });

  it('leaves the newly active station’s tokens alone when a late lookup fails', async () => {
    meAnswer = async () => {
      state.sid = 'b'; // the user switched stations while /api/auth/me was in flight
      return json({ error: 'gone' }, 500);
    };
    expect(await login('a@b.c', 'pw')).toMatchObject({ ok: false });
    expect(clearTokens).not.toHaveBeenCalled();
    expect(setCachedUser).not.toHaveBeenCalled();
  });

  it('does not cache a member that answered for the previous station', async () => {
    meAnswer = async () => {
      state.sid = 'b';
      return json(member);
    };
    expect(await login('a@b.c', 'pw')).toMatchObject({ ok: false });
    expect(setCachedUser).not.toHaveBeenCalled();
    expect(clearTokens).not.toHaveBeenCalled();
  });
});
