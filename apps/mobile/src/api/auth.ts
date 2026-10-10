/**
 * Auth API — internal email/password login, session validation, logout, and
 * the account's language (what the server writes in: Bot greetings, event
 * lines, notifications).
 */

import { getApiBase } from '../store/stations';
import type { AuthenticatedUser } from '../shared/greenhouse-types';
import { t } from '../lib/i18n';
import { api } from './client';
import { setTokens, setCachedUser, clearTokens, getAccessToken, getTokenStationId } from './token-storage';

export type { AuthenticatedUser };

/** Internal user login (email + password). */
export async function login(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string; user?: AuthenticatedUser }> {
  const sid = getTokenStationId();
  try {
    const res = await fetch(`${getApiBase()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || t('login.failed') };
    }
    const data = await res.json();
    // Station switched while the request was in flight — these tokens belong
    // to the previous station; don't write them into the new one's slot.
    if (getTokenStationId() !== sid) return { ok: false, error: t('login.failed') };
    setTokens(data.accessToken, data.refreshToken);
    setCachedUser(data.user);
    return { ok: true, user: data.user };
  } catch {
    return { ok: false, error: t('login.networkError') };
  }
}

/** Validate the stored session against /api/auth/me (refreshes if needed via api()). */
export async function validateSession(): Promise<AuthenticatedUser | null> {
  if (!getAccessToken()) return null;
  const sid = getTokenStationId();
  try {
    const res = await api('/api/auth/me');
    if (!res.ok) return null;
    const data = await res.json();
    // Same in-flight guard as login/refresh: a station switch mid-validate
    // means this user belongs to the previous station — don't cache it here.
    if (getTokenStationId() !== sid) return null;
    setCachedUser(data.user);
    return data.user as AuthenticatedUser;
  } catch {
    return null;
  }
}

export function logout(): void {
  clearTokens();
}

/**
 * Tell the server the account's language (`PUT /api/auth/me/preferences`) — it
 * shapes text the server writes from now on. The member's pick by default (as
 * the web's language switch); `inferred`: the app's own language, which the
 * server only takes for an account whose member never picked one (see
 * src/settings/account-language.ts). Resolves to the account's language after
 * the call, or null when it failed.
 */
export async function saveAccountLocale(
  locale: 'zh' | 'en',
  opts: { inferred?: boolean } = {},
): Promise<{ locale: string; chosen: boolean } | null> {
  try {
    const res = await api('/api/auth/me/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.inferred ? { locale, inferred: true } : { locale }),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { locale?: unknown; locale_chosen?: unknown };
    return {
      locale: typeof data.locale === 'string' ? data.locale : locale,
      chosen: data.locale_chosen === true || !opts.inferred,
    };
  } catch {
    return null;
  }
}
