/**
 * Sign-in, the signed-in member and sign-out on API v2 (`/api/auth/*`, `/api/me`).
 *
 * - `login`: email + password → a token pair for this phone (`client: ios | android`), then the
 *   member. Errors come back as the API's words (`invalid_credentials`, `rate_limited`,
 *   `member_disabled`, `member_not_active` carry a message for people).
 * - `validateSession`: the stored session against `/api/me` (refreshing through `api()`).
 * - `logout`: revokes this phone's refresh token on the server (best effort) and forgets the pair.
 */

import { Platform } from 'react-native';
import { getApiBase } from '../store/stations';
import type { Me, TokenPair, UpdateMeInput } from '../shared/contract';
import { t } from '../lib/i18n';
import { api, patch, toResult, type ApiResult } from './client';
import { checkAborted } from './connection-deadline';
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  getTokenStationId,
  setCachedUser,
  setTokens,
} from './token-storage';

/** What this app is to the server's session list. */
export const CLIENT_KIND = Platform.OS === 'android' ? 'android' : 'ios';

export type LoginOutcome = { ok: true; user: Me } | { ok: false; error: string };

/** Email + password → this station's session and its member. */
export async function login(email: string, password: string): Promise<LoginOutcome> {
  const sid = getTokenStationId();
  try {
    const res = await fetch(`${getApiBase()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, client: CLIENT_KIND }),
    });
    const result = await toResult<TokenPair>(res);
    if (!result.ok) return { ok: false, error: result.message || t('login.failed') };
    // Station switched while the request was in flight — these tokens belong
    // to the previous station; don't write them into the new one's slot.
    if (getTokenStationId() !== sid) return { ok: false, error: t('login.failed') };
    setTokens(result.data.access_token, result.data.refresh_token);
    const me = await toResult<Me>(await api('/api/me'));
    if (!me.ok || getTokenStationId() !== sid) {
      clearTokens();
      return { ok: false, error: me.ok ? t('login.failed') : me.message || t('login.failed') };
    }
    setCachedUser(me.data);
    return { ok: true, user: me.data };
  } catch {
    return { ok: false, error: t('login.networkError') };
  }
}

/**
 * The stored session's member (`GET /api/me`, refreshing through `api()`), or null when there
 * is no session or the server refused it. Throws on an outage when a signal is given, so the
 * startup can tell "signed out" from "unreachable".
 */
export async function validateSession(signal?: AbortSignal): Promise<Me | null> {
  if (!getAccessToken()) return null;
  const sid = getTokenStationId();
  try {
    const res = await api('/api/me', { signal });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error('Station validation failed');
    const me = (await res.json()) as Me;
    checkAborted(signal);
    // Same in-flight guard as login/refresh: a station switch mid-validate
    // means this member belongs to the previous station — don't cache it here.
    if (getTokenStationId() !== sid) return null;
    if (!me || typeof me.id !== 'string' || !me.modules) throw new Error('Invalid station session');
    setCachedUser(me);
    return me;
  } catch (error) {
    if (signal) throw error;
    return null;
  }
}

/** Revoke this phone's refresh token (best effort, never waits long) and forget the session. */
export function logout(): void {
  const refresh = getRefreshToken();
  const base = getApiBase();
  clearTokens();
  if (!refresh) return;
  void fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  }).catch(() => undefined);
}

/** Change my name, picture, language or theme (`PATCH /api/me`); the new member on success. */
export async function updateMe(input: UpdateMeInput): Promise<ApiResult<Me>> {
  const result = await patch<Me>('/api/me', input);
  if (result.ok) setCachedUser(result.data);
  return result;
}
