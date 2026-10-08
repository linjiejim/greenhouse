/**
 * Authenticated fetch with transparent token refresh.
 *
 * Mirrors the web app's authFetch (apps/web/src/lib/auth.ts) but backed by our
 * async-persisted token store. Used for all JSON requests. The streaming chat
 * path (chat.ts) reuses `refreshTokens()` and `getAccessToken()` directly
 * because it needs expo/fetch for response-body streaming.
 *
 * The bearer token only ever goes to the active station's own origin
 * (`onStation`): an absolute URL elsewhere is fetched bare, and its 401 says
 * nothing about this station's session (no refresh, no sign-out).
 */

import { getApiBase } from '../store/stations';
import {
  getAccessToken,
  getRefreshToken,
  getTokenStationId,
  setTokens,
  setCachedUser,
  clearTokens,
} from './token-storage';

let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(cb: () => void): void {
  onUnauthorized = cb;
}

/** The refresh in flight, per station the token mirror belonged to when it started. */
const refreshing = new Map<string | null, Promise<boolean>>();

/**
 * Refresh the active station's access token. Concurrent callers on one station
 * share one refresh (a refresh token rotates: a second one would race the
 * first). Keyed by station: a caller never joins a refresh another station
 * started — that one answers false once a switch made it stale, and a caller
 * on the new station would read that false as "this session is over" and sign
 * the new station out.
 */
export function refreshTokens(): Promise<boolean> {
  const sid = getTokenStationId();
  const pending = refreshing.get(sid);
  if (pending) return pending;
  const run: Promise<boolean> = doRefresh(sid).finally(() => {
    if (refreshing.get(sid) === run) refreshing.delete(sid);
  });
  refreshing.set(sid, run);
  return run;
}

async function doRefresh(sid: string | null): Promise<boolean> {
  // Origin and refresh token are read in the same tick as `sid` (the mirror follows the active station synchronously).
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
    // A station switch mid-refresh repoints the mirror — this rotation belongs
    // to the old station, so writing it now would corrupt the new one's slot.
    if (getTokenStationId() !== sid) return false;
    setTokens(data.accessToken, data.refreshToken);
    if (data.user) setCachedUser(data.user);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `url` is on the station at `base` (same origin, compared parsed — so
 * `@host` userinfo tricks and case differences can't fool it). Only such a URL
 * may carry the station's bearer token.
 */
export function onStation(url: string, base: string): boolean {
  try {
    const station = new URL(base);
    if (station.protocol !== 'https:' && station.protocol !== 'http:') return false;
    return new URL(url).origin === station.origin;
  } catch {
    return false;
  }
}

/**
 * Authenticated fetch against the API. Pass an API-relative path like `/api/sessions`
 * (an absolute URL is fetched as given; it gets the token only on the active station's origin).
 *
 * The origin and the station whose token rides along are read together. A 401 that
 * comes back after the active station changed belongs to the previous station, so it
 * is handed back untouched: refreshing would rotate the new station's pair and retry
 * it to the old origin, and signing out would end the new station's session.
 */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const base = getApiBase();
  const url = /^https?:\/\//i.test(path) ? path : `${base}${path}`;
  const own = onStation(url, base);
  const sid = getTokenStationId();
  const sameStation = () => getTokenStationId() === sid;
  const token = own ? getAccessToken() : null;
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res = await fetch(url, { ...init, headers });
  // Another origin's 401 is about no session of ours.
  if (!own) return res;

  if (res.status === 401 && sameStation()) {
    const ok = await refreshTokens();
    if (!sameStation()) return res;
    if (ok) {
      const retryHeaders = new Headers(init.headers);
      const newToken = getAccessToken();
      if (newToken) retryHeaders.set('Authorization', `Bearer ${newToken}`);
      res = await fetch(url, { ...init, headers: retryHeaders });
      if (res.status === 401 && sameStation()) {
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
