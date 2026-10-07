/**
 * Token storage — secure on native (expo-secure-store), localStorage on web.
 *
 * Tokens are stored **per station** (key suffix `__<stationId>`) so several
 * saved deployments keep their sessions side by side; the in-memory mirror
 * always holds the *active* station's pair. The persisted layer is async, but
 * most call sites (attaching an Authorization header) need a synchronous read,
 * so the mirror is hydrated via `hydrateTokens(stationId)` on startup / station
 * switch and written through on every mutation.
 *
 * The mirror never pairs one station's token with another station's address:
 * every read site takes the origin from the active station (getApiBase), so
 * the mirror follows the active station *synchronously* — `detachTokens` (the
 * station store calls it in the same step that changes `activeId`) empties it
 * and relabels it before anything can read, and `hydrateTokens` then fills it.
 * Between the two the mirror is empty: a request sent then carries no token,
 * and a 401 it gets back can't sign the new station out (see clearTokens).
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
/** Bumped when the mirror changes station or session (detach, setTokens,
 *  clearTokens): a hydrate whose reads started before that is dropped. */
let epoch = 0;
/** Emptied for a new station whose persisted pair isn't read in yet. */
let hydrating = false;

function emptyMirror(): typeof mem {
  return { access: null, refresh: null, user: null };
}

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
 * Point the mirror at `stationId` now — emptied, writes going under its keys —
 * so no read can pair the previous station's token with the new station's
 * address. The station store calls this right before it changes the active
 * station; `hydrateTokens(stationId)` then loads the pair. A no-op when the
 * mirror already belongs to `stationId`.
 */
export function detachTokens(stationId: string | null): void {
  if (stationId === activeSid) return;
  epoch += 1;
  activeSid = stationId;
  mem = emptyMirror();
  hydrating = stationId !== null;
}

/**
 * Load a station's persisted tokens into the in-memory mirror and point all
 * subsequent writes at it. Call once at startup and on every station switch;
 * `null` (no station yet) just empties the mirror. Another station is
 * detached first (synchronously, before the reads); reads that a newer switch
 * or a session write (setTokens / clearTokens) overtook are dropped.
 */
export async function hydrateTokens(stationId: string | null): Promise<void> {
  detachTokens(stationId);
  if (!stationId) return;
  const started = epoch;
  const [access, refresh, userRaw] = await Promise.all([
    persistGet(keyFor(ACCESS_KEY, stationId)),
    persistGet(keyFor(REFRESH_KEY, stationId)),
    persistGet(keyFor(USER_KEY, stationId)),
  ]);
  if (started !== epoch) return;
  mem = { access, refresh, user: userRaw ? safeParseUser(userRaw) : null };
  hydrating = false;
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
  epoch += 1;
  hydrating = false;
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

/**
 * Sign out of the active station — clears its mirror + persisted pair.
 *
 * A no-op while the mirror is detached and not loaded yet (a station switch):
 * nothing could have sent this station's token, so the 401 that led here was
 * about the previous station's, or about none — signing the new station out
 * for it would be wrong, and the pending hydrate still lands.
 */
export function clearTokens(): void {
  if (hydrating) return;
  epoch += 1;
  mem = emptyMirror();
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
