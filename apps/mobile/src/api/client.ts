/**
 * Authenticated fetch with transparent token refresh.
 *
 * Mirrors the web app's authFetch (apps/web/src/lib/auth.ts) but backed by our
 * async-persisted token store. Used for all JSON requests. The streaming chat
 * path (chat.ts) reuses `refreshTokens()` and `getAccessToken()` directly
 * because it needs expo/fetch for response-body streaming.
 */

import { getApiBase } from '../store/stations';
import {
  getAccessToken,
  getRefreshToken,
  setTokens,
  setCachedUser,
  clearTokens,
} from './token-storage';

let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(cb: () => void): void {
  onUnauthorized = cb;
}

let refreshPromise: Promise<boolean> | null = null;

/** Attempt to refresh the access token. De-duped across concurrent callers. */
export function refreshTokens(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefresh().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function doRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${getApiBase()}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    setTokens(data.accessToken, data.refreshToken);
    if (data.user) setCachedUser(data.user);
    return true;
  } catch {
    return false;
  }
}

/** Authenticated fetch against the API. Pass an API-relative path like `/api/sessions`. */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${getApiBase()}${path}`;
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res = await fetch(url, { ...init, headers });

  if (res.status === 401) {
    const ok = await refreshTokens();
    if (ok) {
      const retryHeaders = new Headers(init.headers);
      const newToken = getAccessToken();
      if (newToken) retryHeaders.set('Authorization', `Bearer ${newToken}`);
      res = await fetch(url, { ...init, headers: retryHeaders });
      if (res.status === 401) {
        clearTokens();
        onUnauthorized?.();
      }
    } else {
      clearTokens();
      onUnauthorized?.();
    }
  }
  return res;
}

/** Authenticated GET returning parsed JSON, or `fallback` on any failure. */
export async function apiJson<T>(path: string, fallback: T, init?: RequestInit): Promise<T> {
  try {
    const res = await api(path, init);
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
}
