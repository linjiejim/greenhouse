/**
 * Auth client — login/logout against a self-hosted Greenhouse instance and an
 * authFetch that transparently refreshes an expired access token.
 *
 * Token refresh is delegated to the background service worker (single-flight
 * there), so concurrent 401s from the side panel and the options page can't
 * race the rotation and revoke each other's fresh refresh token.
 */

import { getAuth, setAuth, type StoredAuth } from './storage';

// ─── Base URL handling ───────────────────────────────────

/** Normalize user input to an origin: add https:// if missing, drop path/slash. */
export function normalizeBaseUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withProto).origin;
  } catch {
    return null;
  }
}

/** Ask the user to grant host permission for the instance origin. */
export async function requestHostPermission(baseUrl: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [`${baseUrl}/*`] });
}

/** GET /api/auth/status — reachability + auth-enabled probe (no auth needed). */
export async function checkServer(baseUrl: string): Promise<{ ok: boolean; authEnabled?: boolean }> {
  try {
    const res = await fetch(`${baseUrl}/api/auth/status`);
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { authEnabled?: boolean };
    return { ok: typeof body.authEnabled === 'boolean', authEnabled: body.authEnabled };
  } catch {
    return { ok: false };
  }
}

// ─── Login / logout ──────────────────────────────────────

export async function login(
  baseUrl: string,
  email: string,
  password: string,
): Promise<{ ok: true; auth: StoredAuth } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  const body = (await res.json().catch(() => ({}))) as {
    accessToken?: string;
    refreshToken?: string;
    user?: StoredAuth['user'];
    error?: string;
  };
  if (!res.ok || !body.accessToken || !body.refreshToken || !body.user) {
    return { ok: false, error: body.error ?? `http_${res.status}` };
  }
  const auth: StoredAuth = {
    baseUrl,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    user: body.user,
  };
  await setAuth(auth);
  return { ok: true, auth };
}

export async function logout(): Promise<void> {
  await setAuth(null);
}

// ─── Authenticated fetch with refresh-and-retry ──────────

/** Ask the background worker to refresh the token pair (single-flight there). */
async function refreshViaBackground(): Promise<string | null> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'auth:refresh' })) as {
      ok: boolean;
      accessToken?: string;
    };
    return res?.ok && res.accessToken ? res.accessToken : null;
  } catch {
    return null;
  }
}

/**
 * Fetch `path` (e.g. '/api/auth/me') on the connected instance with a Bearer
 * token; on 401 refresh once and retry. Throws if not connected.
 */
export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const auth = await getAuth();
  if (!auth) throw new Error('not_connected');

  const doFetch = (token: string) =>
    fetch(`${auth.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });

  const first = await doFetch(auth.accessToken);
  if (first.status !== 401) return first;

  const fresh = await refreshViaBackground();
  if (!fresh) return first; // refresh failed → background already cleared auth
  return doFetch(fresh);
}
