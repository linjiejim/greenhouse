/**
 * Frontend auth — dual-mode login, token management, seamless refresh.
 *
 * Tokens stored in localStorage:
 * - greenhouse_access_token  — short-lived access token
 * - greenhouse_refresh_token — long-lived refresh token
 * - greenhouse_user          — cached user info JSON
 *
 * Types (UserRole, AuthenticatedUser) are re-exported from shared types/api.ts
 * so they can be used by React Native and other future clients.
 */

import { apiUrl, resolveFetchInput } from './api-base';

// Re-export shared auth types for backward compatibility
export type { UserRole, AuthenticatedUser } from '@greenhouse/types/api';
import type { AuthenticatedUser } from '@greenhouse/types/api';

// ─── Storage Keys ────────────────────────────────────────

const ACCESS_KEY = 'greenhouse_access_token';
const REFRESH_KEY = 'greenhouse_refresh_token';
const USER_KEY = 'greenhouse_user';

// ─── Token Storage ───────────────────────────────────────

function getItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (_err) {
    return null;
  }
}
function setItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (_err) {
    /* ignore */
  }
}
function removeItem(key: string): void {
  try {
    localStorage.removeItem(key);
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

function storeAuth(accessToken: string, refreshToken: string, user: AuthenticatedUser): void {
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
    storeAuth(data.accessToken, data.refreshToken, data.user);
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

// ─── safeAuthFetch (with fallback for list endpoints) ────

/**
 * Wrapper around authFetch that auto-handles non-ok responses.
 * Returns parsed JSON field value, or the provided fallback on error (403, 500, etc.).
 *
 * Usage:
 *   const tags = await safeAuthFetch<SessionTag[]>('/api/session-tags', 'tags', []);
 *   const doc = await safeAuthFetch<KnowledgeDoc | null>('/api/knowledge/docs/foo', 'doc', null);
 */
export async function safeAuthFetch<T>(url: string, field: string, fallback: T, init?: RequestInit): Promise<T> {
  try {
    const res = await authFetch(url, init);
    if (!res.ok) return fallback;
    const data = await res.json();
    return (data[field] as T) ?? fallback;
  } catch {
    return fallback;
  }
}

// ─── Login ───────────────────────────────────────────────

/**
 * Internal user login (email + password).
 */
export async function loginInternal(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string; user?: AuthenticatedUser }> {
  const res = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data.error || 'Login failed' };
  }

  const data = await res.json();
  const user: AuthenticatedUser = data.user;
  storeAuth(data.accessToken, data.refreshToken, user);
  return { ok: true, user };
}

/**
 * External user login (fixed password).
 */
export async function loginExternal(
  password: string,
): Promise<{ ok: boolean; error?: string; user?: AuthenticatedUser }> {
  const res = await fetch(apiUrl('/api/auth/login/external'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data.error || 'Invalid password' };
  }

  const data = await res.json();
  const user: AuthenticatedUser = data.user;
  storeAuth(data.accessToken, data.refreshToken, user);
  return { ok: true, user };
}

/**
 * Legacy login support (maps to external login).
 */
export async function login(password: string): Promise<{ ok: boolean; error?: string }> {
  return loginExternal(password);
}

// ─── SSO (unified identity binding) ──────────────────────

export interface SsoProviderInfo {
  id: string;
  label: string;
}

/** Enabled SSO providers (empty when none configured — hides the buttons). */
export async function fetchSsoProviders(): Promise<SsoProviderInfo[]> {
  try {
    const res = await fetch(apiUrl('/api/auth/sso/providers'));
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.providers) ? data.providers : [];
  } catch (_err) {
    return [];
  }
}

/** Login-flow entry URL for a provider (top-level navigation target). */
export function ssoAuthorizeUrl(providerId: string, redirect: string): string {
  return apiUrl(`/api/auth/sso/${providerId}/authorize?redirect=${encodeURIComponent(redirect)}`);
}

/**
 * Exchange a one-time SSO ticket (from the IdP callback redirect) for a
 * token pair. Same storage side effects as loginInternal.
 */
export async function exchangeSsoTicket(
  ticket: string,
): Promise<{ ok: boolean; error?: string; user?: AuthenticatedUser }> {
  try {
    const res = await fetch(apiUrl('/api/auth/sso/exchange'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || 'SSO login failed' };
    }
    const data = await res.json();
    const user: AuthenticatedUser = data.user;
    storeAuth(data.accessToken, data.refreshToken, user);
    return { ok: true, user };
  } catch (_err) {
    return { ok: false, error: 'SSO login failed' };
  }
}

// ─── Auth Status ─────────────────────────────────────────

export async function checkAuthStatus(): Promise<boolean> {
  try {
    const res = await fetch(apiUrl('/api/auth/status'));
    if (!res.ok) {
      // If rate-limited (429) or server error, assume auth is enabled
      // (safe default — shows login screen instead of bypassing auth)
      return true;
    }
    const data = await res.json();
    return data.authEnabled === true;
  } catch (_err) {
    // Network error — assume auth is enabled (safe default)
    return true;
  }
}

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

// ─── Deprecated (kept for backward compat) ───────────────

export function storeToken(token: string): void {
  setItem(ACCESS_KEY, token);
}

export async function validateCurrentToken(): Promise<boolean> {
  const user = await validateSession();
  return user !== null;
}
