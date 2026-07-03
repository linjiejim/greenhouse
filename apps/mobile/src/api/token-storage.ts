/**
 * Token storage — secure on native (expo-secure-store), localStorage on web.
 *
 * The persisted layer is async, but most call sites (attaching an Authorization
 * header) need a synchronous read. So we keep an in-memory mirror that is
 * hydrated once at startup via `hydrateTokens()` and written through on every
 * mutation. Reads are sync; writes persist in the background.
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

/** Load persisted tokens into the in-memory mirror. Call once before render. */
export async function hydrateTokens(): Promise<void> {
  const [access, refresh, userRaw] = await Promise.all([
    persistGet(ACCESS_KEY),
    persistGet(REFRESH_KEY),
    persistGet(USER_KEY),
  ]);
  mem.access = access;
  mem.refresh = refresh;
  mem.user = userRaw ? safeParseUser(userRaw) : null;
}

function safeParseUser(raw: string): AuthenticatedUser | null {
  try {
    return JSON.parse(raw) as AuthenticatedUser;
  } catch {
    return null;
  }
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
  persistSet(ACCESS_KEY, access);
  persistSet(REFRESH_KEY, refresh);
}

export function setCachedUser(user: AuthenticatedUser): void {
  mem.user = user;
  persistSet(USER_KEY, JSON.stringify(user));
}

export function clearTokens(): void {
  mem = { access: null, refresh: null, user: null };
  persistSet(ACCESS_KEY, null);
  persistSet(REFRESH_KEY, null);
  persistSet(USER_KEY, null);
}

// ─── UI preferences (non-secret, same persistence backend) ──

const PREF_PREFIX = 'greenhouse_pref_';

export async function loadPref(key: string): Promise<string | null> {
  return persistGet(PREF_PREFIX + key);
}

export async function savePref(key: string, value: string | null): Promise<void> {
  persistSet(PREF_PREFIX + key, value);
}
