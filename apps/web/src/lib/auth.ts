/**
 * Frontend auth — internal login, token management, seamless refresh.
 *
 * Tokens stored in localStorage:
 * - greenhouse_access_token  — short-lived access token
 * - greenhouse_refresh_token — long-lived refresh token
 * - greenhouse_user          — cached user info JSON
 *
 * Types (UserRole, AuthenticatedUser) are re-exported from shared types/api.ts
 * so the browser auth client and API contract use one definition.
 */

import { apiUrl, getApiBaseUrl, resolveFetchInput } from './api-base';

// Re-export shared auth types for backward compatibility
export type { UserRole, AuthenticatedUser } from '@greenhouse/types/api';
import type { AuthenticatedUser } from '@greenhouse/types/api';

// ─── Storage Keys ────────────────────────────────────────

const ACCESS_KEY = 'greenhouse_access_token';
const REFRESH_KEY = 'greenhouse_refresh_token';
const USER_KEY = 'greenhouse_user';

function storageKey(key: string): string {
  return key;
}

// ─── Token Storage ───────────────────────────────────────

function getItem(key: string): string | null {
  try {
    return localStorage.getItem(storageKey(key));
  } catch (_err) {
    return null;
  }
}
function setItem(key: string, value: string): void {
  try {
    localStorage.setItem(storageKey(key), value);
  } catch (_err) {
    /* ignore */
  }
}
function removeItem(key: string): void {
  try {
    localStorage.removeItem(storageKey(key));
  } catch (_err) {
    /* ignore */
  }
}

export function getStoredToken(): string | null {
  return getItem(ACCESS_KEY);
}

export function getStoredRefreshToken(): string | null {
  return getItem(REFRESH_KEY);
}

export function getStoredUser(): AuthenticatedUser | null {
  const raw = getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

export function storeAuthenticatedSession(accessToken: string, refreshToken: string, user: AuthenticatedUser): void {
  setItem(ACCESS_KEY, accessToken);
  setItem(REFRESH_KEY, refreshToken);
  setItem(USER_KEY, JSON.stringify(user));
}

export function clearToken(): void {
  removeItem(ACCESS_KEY);
  removeItem(REFRESH_KEY);
  removeItem(USER_KEY);
}

// ─── Unauthorized Callback ───────────────────────────────

let _onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(cb: () => void): void {
  _onUnauthorized = cb;
}

// ─── Refresh Token Mutex ─────────────────────────────────

let _refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = doRefresh().finally(() => {
    _refreshPromise = null;
  });
  return _refreshPromise;
}

async function doRefresh(): Promise<boolean> {
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) return false;

  try {
    const res = await fetch(apiUrl('/api/auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) return false;

    const data = await res.json();
    storeAuthenticatedSession(data.accessToken, data.refreshToken, data.user);
    return true;
  } catch (_err) {
    return false;
  }
}

// ─── authFetch (with auto-refresh) ───────────────────────

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getStoredToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const resolvedInput = resolveFetchInput(input);
  const res = await fetch(resolvedInput, { ...init, headers });

  // If 401, try refresh
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      // Retry with new token
      const newToken = getStoredToken();
      const retryHeaders = new Headers(init?.headers);
      if (newToken) retryHeaders.set('Authorization', `Bearer ${newToken}`);
      const retryRes = await fetch(resolvedInput, { ...init, headers: retryHeaders });

      if (retryRes.status === 401 && _onUnauthorized) {
        _onUnauthorized();
      }
      return retryRes;
    }

    // Refresh failed — back to login
    if (_onUnauthorized) _onUnauthorized();
  }

  // 403 handling — detect stale sessions or needsAuth
  if (res.status === 403) {
    try {
      const cloned = res.clone();
      const data = await cloned.json();
      if (data.needsAuth) {
        if (_onUnauthorized) _onUnauthorized();
      } else if (data.role) {
        // Server returned the user's actual role — compare with cached user.
        // A mismatch means stale session (e.g. logged in as different user in another tab).
        const cached = getStoredUser();
        if (cached && cached.role !== data.role) {
          if (_onUnauthorized) _onUnauthorized();
        }
      }
    } catch (_err) {
      /* not JSON, ignore */
    }
  }

  return res;
}

// ─── Login ───────────────────────────────────────────────

/**
 * Internal user login (email + password).
 *
 * Never throws. A rejected `fetch` — offline, server down, a cross-origin request
 * the server doesn't allow — used to propagate out of here and leave the login
 * button spinning on "Signing in…" forever with nothing on screen. Reaching the
 * server and being refused is a different problem from not reaching it at all, so
 * the two get different messages.
 */
export async function loginInternal(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string; user?: AuthenticatedUser }> {
  let res: Response;
  try {
    res = await fetch(apiUrl('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (_err) {
    // The browser deliberately hides *why* (CORS vs DNS vs TLS vs offline), so
    // naming the server is the most useful thing we can say.
    const target = getApiBaseUrl() || 'the server';
    return { ok: false, error: `Could not reach ${target}. Check your connection and try again.` };
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data.error || `Login failed (${res.status})` };
  }

  try {
    const data = await res.json();
    const user: AuthenticatedUser = data.user;
    if (!user || !data.accessToken) {
      return { ok: false, error: 'Login response was malformed' };
    }
    storeAuthenticatedSession(data.accessToken, data.refreshToken, user);
    return { ok: true, user };
  } catch (_err) {
    return { ok: false, error: 'Login response was not readable' };
  }
}

// ─── Auth Status ─────────────────────────────────────────

/**
 * Validate the current session — try the stored access token,
 * then attempt refresh if needed.
 */
export async function validateSession(): Promise<AuthenticatedUser | null> {
  const token = getStoredToken();
  if (!token) return null;

  try {
    // Try /api/auth/me with current token
    const res = await fetch(apiUrl('/api/auth/me'), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) {
      const data = await res.json();
      const user = data.user as AuthenticatedUser;
      // Update cached user
      setItem(USER_KEY, JSON.stringify(user));
      return user;
    }

    // Token expired — try refresh
    if (res.status === 401) {
      const refreshed = await tryRefresh();
      if (refreshed) {
        return getStoredUser();
      }
    }

    return null;
  } catch (_err) {
    return null;
  }
}
