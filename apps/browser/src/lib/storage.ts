/**
 * Extension storage — the station registry in chrome.storage.local.
 *
 * A "station" is a saved connection to one self-hosted Greenhouse instance:
 * normalized origin + an optional signed-in token pair. Several stations can
 * be stored side by side; exactly one is active and every API call resolves
 * against it. The user's password is never stored — only the token pair from
 * /api/auth/login survives, and the refresh rotation in the background worker
 * keeps each station's session alive independently.
 *
 * The build-time config (src/config.ts) shapes the registry: `defaults` are
 * seeded on the first read of a fresh install, and a `single`-mode build is
 * locked to one station — the registry only ever holds it, and add / remove /
 * switch are guarded here so no UI path can escape the lock.
 */

import { defaultStations, isSingleStation } from '../config';

export interface AuthUser {
  id: string;
  email?: string;
  nickname: string;
  role: string;
  locale?: string;
}

/** A station's signed-in session. Absent (null) ⇒ signed out, entry kept. */
export interface StationAuth {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface Station {
  /** Deterministic id derived from the origin (stable across contexts). */
  id: string;
  /** Normalized origin of the Greenhouse instance, no trailing slash. */
  baseUrl: string;
  /** Display name; defaults to the host. */
  name: string;
  auth: StationAuth | null;
}

export interface StationsState {
  stations: Station[];
  activeId: string | null;
}

/** Active station's session flattened for API call sites. */
export interface StoredAuth extends StationAuth {
  stationId: string;
  baseUrl: string;
}

const STATIONS_KEY = 'stations';
/** Pre-multi-station single-connection slot; lazily migrated then removed. */
const LEGACY_AUTH_KEY = 'auth';

const EMPTY_STATE: StationsState = { stations: [], activeId: null };

/**
 * Station id from the origin (djb2 hash). Deterministic so concurrent legacy
 * migrations from two extension contexts converge on identical output, and a
 * re-added origin reuses its old id. Origins are unique per station (adding a
 * duplicate switches instead), so this cannot collide in practice.
 */
export function stationIdFor(baseUrl: string): string {
  let h = 5381;
  for (let i = 0; i < baseUrl.length; i++) h = (h * 33 + baseUrl.charCodeAt(i)) >>> 0;
  return `st-${h.toString(36)}`;
}

/** Host shown as the default station name ("greenhouse.example.com"). */
export function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

// ─── Base URL handling ───────────────────────────────────

/**
 * Normalize user input (or a configured default) to an origin: add a scheme
 * if missing, drop path/slash. Bare IPs / localhost default to http:// (LAN
 * self-hosts rarely have TLS); everything else defaults to https://. An
 * explicit scheme always wins.
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

// ─── Build-time defaults ─────────────────────────────────

/**
 * Signed-out stations from the build config, ids derived from the origin like
 * every other station. Unusable or duplicate origins are skipped.
 */
function configuredStations(): Station[] {
  const stations: Station[] = [];
  for (const d of defaultStations()) {
    const baseUrl = normalizeBaseUrl(d.url);
    if (!baseUrl || stations.some((s) => s.baseUrl === baseUrl)) continue;
    stations.push({ id: stationIdFor(baseUrl), baseUrl, name: d.name.trim() || hostLabel(baseUrl), auth: null });
  }
  return stations;
}

/** The one station a `single`-mode build is locked to (null in `multi`). */
function lockedStation(): Station | null {
  return isSingleStation() ? (configuredStations()[0] ?? null) : null;
}

/** First-launch registry: the configured defaults, first one active. */
function seedDefaults(): StationsState {
  const stations = configuredStations();
  return stations.length > 0 ? { stations, activeId: stations[0].id } : EMPTY_STATE;
}

/**
 * The registry a `single`-mode build must hold: exactly the locked station,
 * active. A stored entry with that origin is kept (its session survives an
 * upgrade from a multi-station build); anything else is unreachable in this
 * build and dropped. Returns `state` itself when nothing has to change.
 */
function lockToStation(state: StationsState, locked: Station): StationsState {
  const existing = state.stations.find((s) => s.baseUrl === locked.baseUrl);
  const station = existing ? { ...existing, name: locked.name } : locked;
  const alreadyLocked =
    state.stations.length === 1 &&
    state.stations[0].id === station.id &&
    state.stations[0].name === station.name &&
    state.activeId === station.id;
  return alreadyLocked ? state : { stations: [station], activeId: station.id };
}

interface LegacyStoredAuth {
  baseUrl: string;
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

/** Pure legacy single-slot → registry conversion (exported for tests). */
export function migrateLegacyAuth(legacy: LegacyStoredAuth): StationsState {
  const id = stationIdFor(legacy.baseUrl);
  return {
    stations: [
      {
        id,
        baseUrl: legacy.baseUrl,
        name: hostLabel(legacy.baseUrl),
        auth: {
          accessToken: legacy.accessToken,
          refreshToken: legacy.refreshToken,
          user: legacy.user,
        },
      },
    ],
    activeId: id,
  };
}

/**
 * Read the registry. The first read on an install migrates the legacy single
 * `auth` slot, else seeds the configured defaults (a registry the user
 * emptied on purpose is left alone). A `single`-mode build re-locks the
 * registry on every read, so it can never drift away from its station.
 */
export async function getStations(): Promise<StationsState> {
  const record = await chrome.storage.local.get([STATIONS_KEY, LEGACY_AUTH_KEY]);
  let state = record[STATIONS_KEY] as StationsState | undefined;
  if (!state) {
    const legacy = record[LEGACY_AUTH_KEY] as LegacyStoredAuth | undefined;
    if (legacy) {
      state = migrateLegacyAuth(legacy);
      await chrome.storage.local.set({ [STATIONS_KEY]: state });
      await chrome.storage.local.remove(LEGACY_AUTH_KEY);
    } else {
      state = seedDefaults();
      if (state.stations.length > 0) await setStations(state);
    }
  }
  const locked = lockedStation();
  if (locked) {
    const next = lockToStation(state, locked);
    if (next !== state) {
      await setStations(next);
      state = next;
    }
  }
  return state;
}

async function setStations(state: StationsState): Promise<void> {
  await chrome.storage.local.set({ [STATIONS_KEY]: state });
}

export async function getActiveStation(): Promise<Station | null> {
  const { stations, activeId } = await getStations();
  return stations.find((s) => s.id === activeId) ?? null;
}

/** Active station's signed-in session, or null (no station / signed out). */
export async function getAuth(): Promise<StoredAuth | null> {
  const station = await getActiveStation();
  if (!station?.auth) return null;
  return { stationId: station.id, baseUrl: station.baseUrl, ...station.auth };
}

/**
 * Add a station and make it active. Origins are unique: adding an existing
 * one just switches to it (keeping its saved session). A `single`-mode build
 * refuses every origin but its locked station.
 */
export async function addStation(baseUrl: string, name?: string): Promise<Station> {
  const locked = lockedStation();
  if (locked && baseUrl !== locked.baseUrl) {
    throw new Error(`This build is locked to ${locked.name} (${locked.baseUrl}); cannot add ${baseUrl}`);
  }
  const state = await getStations();
  const existing = state.stations.find((s) => s.baseUrl === baseUrl);
  if (existing) {
    if (state.activeId !== existing.id) await setStations({ ...state, activeId: existing.id });
    return existing;
  }
  const station: Station = {
    id: stationIdFor(baseUrl),
    baseUrl,
    name: name?.trim() || hostLabel(baseUrl),
    auth: null,
  };
  await setStations({ stations: [...state.stations, station], activeId: station.id });
  return station;
}

/**
 * Remove a station; if it was active, the first remaining one takes over.
 * No-op for the locked station of a `single`-mode build.
 */
export async function removeStation(id: string): Promise<void> {
  if (lockedStation()?.id === id) return;
  const state = await getStations();
  const stations = state.stations.filter((s) => s.id !== id);
  const activeId = state.activeId === id ? (stations[0]?.id ?? null) : state.activeId;
  await setStations({ stations, activeId });
}

/** Make a station active. No-op in a `single`-mode build (its station always is). */
export async function setActiveStation(id: string): Promise<void> {
  if (isSingleStation()) return;
  const state = await getStations();
  if (state.activeId === id || !state.stations.some((s) => s.id === id)) return;
  await setStations({ ...state, activeId: id });
}

/**
 * Write one station's session (login / refresh rotation / sign-out). Re-reads
 * the latest registry so it can't clobber concurrent edits to other stations;
 * no-op if the station was removed meanwhile.
 */
export async function updateStationAuth(id: string, auth: StationAuth | null): Promise<void> {
  const state = await getStations();
  if (!state.stations.some((s) => s.id === id)) return;
  await setStations({
    ...state,
    stations: state.stations.map((s) => (s.id === id ? { ...s, auth } : s)),
  });
}

/** Subscribe to registry changes (login/logout/rotation/switch) from any context. */
export function onStationsChange(cb: (state: StationsState) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && STATIONS_KEY in changes) {
      cb((changes[STATIONS_KEY].newValue as StationsState | undefined) ?? EMPTY_STATE);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
