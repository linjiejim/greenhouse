/**
 * Sign-in, the signed-in member and sign-out (`/api/auth/*`, apps/api/src/routes/auth.ts).
 *
 * - `login`: email + password → a token pair for this station, then the member (`/api/auth/me`).
 *   Errors come back as the server's words ("Invalid email or password", a disabled account,
 *   too many attempts).
 * - `validateSession`: the stored session against `/api/auth/me` (refreshing through `api()`).
 * - `logout`: forgets this station's pair. The server keeps no per-phone session to revoke; the
 *   refresh token simply expires.
 * - `saveLocale`: the account's language (`PUT /api/auth/me/preferences`).
 */

import { getApiBase } from '../store/stations';
import type { Me, MePreferences, SessionTokens } from '../shared/greenhouse-types';
import { t } from '../lib/i18n';
import { api, put, toResult, type ApiResult } from './client';
import { checkAborted } from './connection-deadline';
import { parseMe } from './me';
import { clearTokens, getAccessToken, getCachedUser, getTokenStationId, setCachedUser, setTokens } from './token-storage';

export type LoginOutcome = { ok: true; user: Me } | { ok: false; error: string };

/** Email + password → this station's session and its member. */
export async function login(email: string, password: string): Promise<LoginOutcome> {
  const sid = getTokenStationId();
  try {
    const res = await fetch(`${getApiBase()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const result = await toResult<SessionTokens>(res);
    if (!result.ok) return { ok: false, error: result.message || t('login.failed') };
    // Station switched while the request was in flight — these tokens belong
    // to the previous station; don't write them into the new one's slot.
    if (getTokenStationId() !== sid) return { ok: false, error: t('login.failed') };
    if (typeof result.data.accessToken !== 'string' || typeof result.data.refreshToken !== 'string') {
      return { ok: false, error: t('login.failed') };
    }
    setTokens(result.data.accessToken, result.data.refreshToken);
    const me = await toResult<unknown>(await api('/api/auth/me'));
    // Another station became active meanwhile: its tokens are in the mirror now, not ours —
    // never clear them for this station's late answer.
    if (getTokenStationId() !== sid) return { ok: false, error: t('login.failed') };
    const user = me.ok ? parseMe(me.data) : null;
    if (!user) {
      clearTokens();
      return { ok: false, error: me.ok ? t('login.failed') : me.message || t('login.failed') };
    }
    setCachedUser(user);
    return { ok: true, user };
  } catch {
    return { ok: false, error: t('login.networkError') };
  }
}

/**
 * The stored session's member (`GET /api/auth/me`, refreshing through `api()`), or null when
 * there is no session or the server refused it. Throws on an outage when a signal is given, so
 * the startup can tell "signed out" from "unreachable".
 */
export async function validateSession(signal?: AbortSignal): Promise<Me | null> {
  if (!getAccessToken()) return null;
  const sid = getTokenStationId();
  try {
    const res = await api('/api/auth/me', { signal });
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error('Station validation failed');
    const user = parseMe(await res.json());
    checkAborted(signal);
    // Same in-flight guard as login/refresh: a station switch mid-validate
    // means this member belongs to the previous station — don't cache it here.
    if (getTokenStationId() !== sid) return null;
    if (!user) throw new Error('Invalid station session');
    setCachedUser(user);
    return user;
  } catch (error) {
    if (signal) throw error;
    return null;
  }
}

/** Forget this station's session. */
export function logout(): void {
  clearTokens();
}

/** Change the account's language; the member as it is now on success. */
export async function saveLocale(locale: 'zh' | 'en'): Promise<ApiResult<Me>> {
  const result = await put<MePreferences>('/api/auth/me/preferences', { locale });
  if (!result.ok) return result;
  const cached = getCachedUser();
  if (!cached) return { ok: false, status: 0, code: 'internal', message: '' };
  const user = { ...cached, locale: result.data.locale };
  setCachedUser(user);
  return { ok: true, data: user };
}
