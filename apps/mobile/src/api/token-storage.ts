/**
 * Token storage — secure on native (expo-secure-store), localStorage on web.
 *
 * Tokens are stored **per station** (key suffix `__<stationId>`) so several
 * saved deployments keep their sessions side by side; the in-memory mirror
 * always holds the *active* station's pair. The persisted layer is async, but
 * most call sites (attaching an Authorization header) need a synchronous read,
 * so the mirror is hydrated via `hydrateTokens(stationId)` on startup / station
 * switch and written through on every mutation.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { AuthenticatedUser } from '../shared/greenhouse-types';

const ACCESS_KEY = 'greenhouse_access_token';
const REFRESH_KEY = 'greenhouse_refresh_token';
const USER_KEY = 'greenhouse_user';

const isWeb = Platform.OS === 'web';

let mem: { access: string | null; refresh: string | null; user: AuthenticatedUser | null } = {
  access: null,
  refresh: null,
  user: null,
};
/** Station whose tokens the mirror holds; writes go under its keys. */
let activeSid: string | null = null;

/** SecureStore-safe per-station key ([A-Za-z0-9._-] only). */
function keyFor(base: string, sid: string): string {
  return `${base}__${sid}`;
}

// ─── persistence primitives ──────────────────────────────

async function persistGet(key: string): Promise<string | null> {
  try {
    if (isWeb) return globalThis.localStorage?.getItem(key) ?? null;
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

function persistSet(key: string, value: string | null): void {
  try {
    if (isWeb) {
      if (value == null) globalThis.localStorage?.removeItem(key);
      else globalThis.localStorage?.setItem(key, value);
      return;
    }
    if (value == null) void SecureStore.deleteItemAsync(key);
    else void SecureStore.setItemAsync(key, value);
  } catch {
    /* ignore — best effort */
  }
}

// ─── public API ──────────────────────────────────────────

/**
 * Load a station's persisted tokens into the in-memory mirror and point all
 * subsequent writes at it. Call once at startup and on every station switch;
 * `null` (no station yet) just empties the mirror.
 */
export async function hydrateTokens(stationId: string | null): Promise<void> {
  activeSid = stationId;
  if (!stationId) {
    mem = { access: null, refresh: null, user: null };
    return;
  }
  const [access, refresh, userRaw] = await Promise.all([
    persistGet(keyFor(ACCESS_KEY, stationId)),
    persistGet(keyFor(REFRESH_KEY, stationId)),
    persistGet(keyFor(USER_KEY, stationId)),
  ]);
  mem = { access, refresh, user: userRaw ? safeParseUser(userRaw) : null };
}

function safeParseUser(raw: string): AuthenticatedUser | null {
  try {
    return JSON.parse(raw) as AuthenticatedUser;
  } catch {
    return null;
  }
}

/** Station the mirror currently belongs to (guards async writes across switches). */
export function getTokenStationId(): string | null {
  return activeSid;
}

export function getAccessToken(): string | null {
  return mem.access;
}
export function getRefreshToken(): string | null {
  return mem.refresh;
}
export function getCachedUser(): AuthenticatedUser | null {
  return mem.user;
}

export function setTokens(access: string, refresh: string): void {
  mem.access = access;
  mem.refresh = refresh;
  if (!activeSid) return;
  persistSet(keyFor(ACCESS_KEY, activeSid), access);
  persistSet(keyFor(REFRESH_KEY, activeSid), refresh);
}

export function setCachedUser(user: AuthenticatedUser): void {
  mem.user = user;
  if (activeSid) persistSet(keyFor(USER_KEY, activeSid), JSON.stringify(user));
}

/** Sign out of the active station — clears its mirror + persisted pair. */
export function clearTokens(): void {
  mem = { access: null, refresh: null, user: null };
  if (activeSid) purgeStationTokens(activeSid);
}

/** Delete a station's persisted tokens (station removal / sign-out cleanup). */
export function purgeStationTokens(stationId: string): void {
  persistSet(keyFor(ACCESS_KEY, stationId), null);
  persistSet(keyFor(REFRESH_KEY, stationId), null);
  persistSet(keyFor(USER_KEY, stationId), null);
}

/**
 * One-time adoption of the pre-station un-suffixed keys: move them under
 * `stationId` and delete the legacy entries. Returns whether a legacy session
 * existed (the caller uses this to decide seeding).
 */
export async function migrateLegacyTokens(stationId: string): Promise<boolean> {
  const [access, refresh, userRaw] = await Promise.all([
    persistGet(ACCESS_KEY),
    persistGet(REFRESH_KEY),
    persistGet(USER_KEY),
  ]);
  if (!access && !refresh) return false;
  if (access) persistSet(keyFor(ACCESS_KEY, stationId), access);
  if (refresh) persistSet(keyFor(REFRESH_KEY, stationId), refresh);
  if (userRaw) persistSet(keyFor(USER_KEY, stationId), userRaw);
  persistSet(ACCESS_KEY, null);
  persistSet(REFRESH_KEY, null);
  persistSet(USER_KEY, null);
  return true;
}

// ─── UI preferences (non-secret, same persistence backend) ──

const PREF_PREFIX = 'greenhouse_pref_';

export async function loadPref(key: string): Promise<string | null> {
  return persistGet(PREF_PREFIX + key);
}

export async function savePref(key: string, value: string | null): Promise<void> {
  persistSet(PREF_PREFIX + key, value);
}
