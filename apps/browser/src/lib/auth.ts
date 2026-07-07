/**
 * Auth client — sign in/out of a station and an authFetch that talks to the
 * active station, transparently refreshing an expired access token.
 *
 * Token refresh is delegated to the background service worker (single-flight
 * per station there), so concurrent 401s from the side panel and the options
 * page can't race the rotation and revoke each other's fresh refresh token.
 */

import { getAuth, removeStation, updateStationAuth, type Station, type StationAuth } from './storage';

// ─── Base URL handling ───────────────────────────────────

/**
 * Normalize user input to an origin: add a scheme if missing, drop path/slash.
 * Bare IPs / localhost default to http:// (LAN self-hosts rarely have TLS);
 * everything else defaults to https://. An explicit scheme always wins.
 */
export function normalizeBaseUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `${defaultScheme(trimmed)}://${trimmed}`;
  try {
    return new URL(withProto).origin;
  } catch {
    return null;
  }
}

function defaultScheme(input: string): 'http' | 'https' {
  const authority = input.split('/')[0];
  // [::1]-style IPv6 literals, localhost, and dotted IPv4s are LAN targets.
  const host = authority.startsWith('[') ? authority : authority.split(':')[0];
  if (host === 'localhost' || host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'http';
  return 'https';
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

// ─── Sign in / out ───────────────────────────────────────

export async function login(
  station: Pick<Station, 'id' | 'baseUrl'>,
  email: string,
  password: string,
): Promise<{ ok: true; auth: StationAuth } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${station.baseUrl}/api/auth/login`, {
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
    user?: StationAuth['user'];
    error?: string;
  };
  if (!res.ok || !body.accessToken || !body.refreshToken || !body.user) {
    return { ok: false, error: body.error ?? `http_${res.status}` };
  }
  const auth: StationAuth = {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    user: body.user,
  };
  await updateStationAuth(station.id, auth);
  return { ok: true, auth };
}

/** Sign out of one station — clears its session, keeps the registry entry. */
export async function logout(stationId: string): Promise<void> {
  await updateStationAuth(stationId, null);
}

/**
 * Remove a station and best-effort revoke its origin permission (origins are
 * unique per station, so no other entry can still need it).
 */
export async function forgetStation(station: Station): Promise<void> {
  await removeStation(station.id);
  try {
    await chrome.permissions.remove({ origins: [`${station.baseUrl}/*`] });
  } catch {
    // Already gone or not removable — nothing to clean up.
  }
}

// ─── Authenticated fetch with refresh-and-retry ──────────

/** Ask the background worker to refresh a station's token pair (single-flight there). */
async function refreshViaBackground(stationId: string): Promise<string | null> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'auth:refresh', stationId })) as {
      ok: boolean;
      accessToken?: string;
    };
    return res?.ok && res.accessToken ? res.accessToken : null;
  } catch {
    return null;
  }
}

/**
 * Fetch `path` (e.g. '/api/auth/me') on the active station with a Bearer
 * token; on 401 refresh once and retry. Throws if no station is signed in.
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

  const fresh = await refreshViaBackground(auth.stationId);
  if (!fresh) return first; // refresh failed → background already cleared this station's session
  return doFetch(fresh);
}
