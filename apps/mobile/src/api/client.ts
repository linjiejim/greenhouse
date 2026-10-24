/**
 * Authenticated fetch with transparent token refresh, and the typed calls built on it.
 *
 * Every call to a station goes through `api()`: it attaches the active station's access token,
 * and on a 401 refreshes once (`POST /api/auth/refresh` with the single-use refresh token — one
 * refresh at a time per station, however many requests failed) and retries. A refused refresh
 * (400, 401, 403) ends the session; an outage keeps it.
 *
 * The bearer token only ever goes to the active station's own origin (`onStation`): an absolute
 * URL elsewhere is fetched bare, and its 401 says nothing about this station's session.
 *
 * `request()` and its verbs answer an `ApiResult`: the parsed body, or a miss carrying a stable
 * `code` derived from the status (`network` when nothing came back) and the server's words
 * (the v1 envelope is `{ error: '<message>' }`). They never throw.
 */

import { getApiBase } from '../store/stations';
import type { SessionTokens } from '../shared/greenhouse-types';
import { checkAborted, withConnectionDeadline } from './connection-deadline';
import { clearTokens, getAccessToken, getRefreshToken, getTokenStationId, setTokens } from './token-storage';

let onUnauthorized: (() => void) | null = null;
let transport: typeof fetch = (...args) => fetch(...args);
/** The native app installs Expo fetch so multipart File bodies carry bytes, not URI descriptors. */
export function setTransport(fetcher: typeof fetch): void {
  transport = fetcher;
}
export function setOnUnauthorized(cb: () => void): void {
  onUnauthorized = cb;
}

/** The refresh in flight, per station the token mirror belonged to when it started. */
const refreshing = new Map<string | null, { promise: Promise<boolean>; signal?: AbortSignal }>();

/**
 * Refresh the active station's access token. Concurrent callers on one station share one
 * refresh (a refresh token is single use: replaying a spent one ends every session of the
 * member). Keyed by station: a caller never joins a refresh another station started — that one
 * answers false once a switch made it stale, and a caller on the new station would read that
 * false as "this session is over" and sign the new station out.
 */
export function refreshTokens(signal?: AbortSignal): Promise<boolean> {
  checkAborted(signal);
  const sid = getTokenStationId();
  const pending = refreshing.get(sid);
  if (pending && !pending.signal?.aborted) return pending.promise;
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  // Background refreshes also expire, so a later bootstrap cannot keep joining a hung rotation.
  const run: Promise<boolean> = withConnectionDeadline((attempt) => doRefresh(sid, attempt), controller).finally(() => {
    signal?.removeEventListener('abort', cancel);
    if (refreshing.get(sid)?.promise === run) refreshing.delete(sid);
  });
  refreshing.set(sid, { promise: run, signal: controller.signal });
  return run;
}

async function doRefresh(sid: string | null, signal?: AbortSignal): Promise<boolean> {
  // Origin and refresh token are read in the same tick as `sid` (the mirror follows the active station synchronously).
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  const res = await transport(`${getApiBase()}/api/auth/refresh`, {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  checkAborted(signal);
  if (getTokenStationId() !== sid) return false;
  if (!res.ok) {
    // Only a refused refresh ends the session; outages must be retryable.
    if (res.status !== 400 && res.status !== 401 && res.status !== 403) throw new Error('Station refresh failed');
    return false;
  }
  const data = (await res.json()) as Partial<SessionTokens>;
  checkAborted(signal);
  // A station switch mid-refresh repoints the mirror — this rotation belongs
  // to the old station, so writing it now would corrupt the new one's slot.
  if (getTokenStationId() !== sid) return false;
  if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string') return false;
  setTokens(data.accessToken, data.refreshToken);
  return true;
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
 * Authenticated fetch against the API. Pass an API-relative path like `/api/auth/me` (an absolute URL
 * is fetched as given; it gets the token only on the active station's origin).
 *
 * `via` fetches instead of the default transport for one call (the assistant streams its reply
 * through Expo's fetch, whose body can be read as it arrives).
 *
 * The origin and the station whose token rides along are read together. A 401 that
 * comes back after the active station changed belongs to the previous station, so it
 * is handed back untouched: refreshing would rotate the new station's pair and retry
 * it to the old origin, and signing out would end the new station's session.
 */
export async function api(path: string, init: RequestInit = {}, via: typeof fetch = transport): Promise<Response> {
  checkAborted(init.signal);
  const base = getApiBase();
  const url = /^https?:\/\//i.test(path) ? path : `${base}${path}`;
  const own = onStation(url, base);
  const sid = getTokenStationId();
  const sameStation = () => getTokenStationId() === sid;
  const token = own ? getAccessToken() : null;
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res = await via(url, { ...init, headers });
  checkAborted(init.signal);
  // Another origin's 401 is about no session of ours.
  if (!own) return res;

  if (res.status === 401 && sameStation()) {
    const ok = await refreshTokens(init.signal ?? undefined);
    checkAborted(init.signal);
    if (!sameStation()) return res;
    if (ok) {
      const retryHeaders = new Headers(init.headers);
      const newToken = getAccessToken();
      if (newToken) retryHeaders.set('Authorization', `Bearer ${newToken}`);
      res = await via(url, { ...init, headers: retryHeaders });
      checkAborted(init.signal);
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

/** Why a call came back without its result: the status as a stable code, or `network`. */
export interface ApiMiss {
  ok: false;
  /** HTTP status; 0 when nothing came back. */
  status: number;
  /** A stable snake_case code (`not_found`, `conflict`, …; the envelope's own when it has one), or `network`. */
  code: string;
  /** For people (the server's words); may be empty. */
  message: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | ApiMiss;

type Query = Record<string, string | number | boolean | null | undefined>;

/** `?a=1&b=x` from the defined entries, or ''. */
export function queryString(query?: Query): string {
  const entries = Object.entries(query ?? {}).filter(
    (entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== null,
  );
  if (!entries.length) return '';
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&')}`;
}

/** A response as an `ApiResult`: 204 is `undefined`, any other success its JSON. */
export async function toResult<T>(res: Response): Promise<ApiResult<T>> {
  if (res.status === 204) return { ok: true, data: undefined as T };
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (res.ok)
    return body === undefined
      ? { ok: false, status: res.status, code: 'invalid_response', message: 'The server response could not be read.' }
      : { ok: true, data: body as T };
  const error = (body as { error?: unknown } | undefined)?.error;
  // v1 answers `{ error: 'words' }` (some with a top-level `code`); a few routes answer `{ error: { code, message } }`.
  const envelope = error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown }) : null;
  const topCode = (body as { code?: unknown } | undefined)?.code;
  return {
    ok: false,
    status: res.status,
    code: typeof envelope?.code === 'string' ? envelope.code : typeof topCode === 'string' ? topCode : statusCode(res.status),
    message: typeof error === 'string' ? error : typeof envelope?.message === 'string' ? envelope.message : '',
    details: (body as { details?: unknown } | undefined)?.details,
  };
}

/** The status as a stable code for callers that branch on it. */
export function statusCode(status: number): string {
  if (status === 400) return 'invalid';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'unavailable' : 'internal';
}

/** A miss for a call that never got an answer. */
export function networkMiss(error: unknown): ApiMiss {
  return { ok: false, status: 0, code: 'network', message: error instanceof Error ? error.message : String(error) };
}

/** One call to the active station, as an `ApiResult`. JSON bodies are sent as JSON, FormData as is. */
export async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown; query?: Query; signal?: AbortSignal } = {},
): Promise<ApiResult<T>> {
  try {
    const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const res = await api(`${path}${queryString(options.query)}`, {
      method,
      signal: options.signal,
      headers: options.body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body === undefined ? undefined : isForm ? (options.body as FormData) : JSON.stringify(options.body),
    });
    return await toResult<T>(res);
  } catch (error) {
    return networkMiss(error);
  }
}

export const get = <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal });
export const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, { body });
export const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, { body });
export const put = <T>(path: string, body: unknown) => request<T>('PUT', path, { body });
export const del = <T = void>(path: string, query?: Query) => request<T>('DELETE', path, { query });

/** A read that only matters when it worked: the data, or null. */
export async function read<T>(call: Promise<ApiResult<T>>): Promise<T | null> {
  const result = await call;
  return result.ok ? result.data : null;
}

/** Path segment for an id (never trust a value pasted into a URL). */
export const seg = (id: string) => encodeURIComponent(id);
