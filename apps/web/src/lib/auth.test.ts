import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginInternal } from './auth.js';

/**
 * Regression guard for a login button that span on "Signing in…" forever.
 *
 * A rejected `fetch` (offline, server down, a cross-origin request the server
 * refuses) propagated out of `loginInternal`, past the caller's un-guarded `await`,
 * so `setLoading(false)` never ran and nothing appeared on screen. It reproduces for
 * real whenever the SPA is served from an origin the API has not allowlisted.
 */

function stubFetch(impl: () => Promise<unknown>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  delete (globalThis as { location?: unknown }).location;
});

describe('loginInternal', () => {
  it('reports an unreachable server instead of throwing', async () => {
    // What a CORS rejection actually looks like to JS: an opaque TypeError.
    stubFetch(() => Promise.reject(new TypeError('Load failed')));

    const result = await loginInternal('jim@example.com', 'secret');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not reach/i);
  });

  it('surfaces the server error message on a rejected credential', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'Invalid password' }) }),
    );

    const result = await loginInternal('jim@example.com', 'wrong');
    expect(result).toEqual({ ok: false, error: 'Invalid password' });
  });

  it('falls back to the status code when the body carries no message', async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error('no body')) }));

    const result = await loginInternal('jim@example.com', 'secret');
    expect(result.error).toContain('502');
  });

  it('rejects a 200 response that is missing the token or user', async () => {
    // Better to say so than to store `undefined` and fail mysteriously later.
    stubFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ user: null }) }));

    const result = await loginInternal('jim@example.com', 'secret');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/malformed/i);
  });

  it('stores credentials and returns the user on success', async () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    const user = { id: 1, email: 'jim@example.com', role: 'super' };
    stubFetch(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ accessToken: 'a', refreshToken: 'r', user }),
      }),
    );

    const result = await loginInternal('jim@example.com', 'secret');
    expect(result.ok).toBe(true);
    expect(result.user).toEqual(user);
    expect(store.get('greenhouse_access_token')).toBe('a');
  });
});
