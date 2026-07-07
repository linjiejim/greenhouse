/**
 * Auth API — internal email/password login, session validation, logout.
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
  try {
    const res = await api('/api/auth/me');
    if (!res.ok) return null;
    const data = await res.json();
    setCachedUser(data.user);
    return data.user as AuthenticatedUser;
  } catch {
    return null;
  }
}

export function logout(): void {
  clearTokens();
}
