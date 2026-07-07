/**
 * Extension storage — the station registry in chrome.storage.local.
 *
 * A "station" is a saved connection to one self-hosted Greenhouse instance:
 * normalized origin + an optional signed-in token pair. Several stations can
 * be stored side by side; exactly one is active and every API call resolves
 * against it. The user's password is never stored — only the token pair from
 * /api/auth/login survives, and the refresh rotation in the background worker
 * keeps each station's session alive independently.
 */

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

/** Read the registry, migrating the legacy single `auth` slot on first touch. */
export async function getStations(): Promise<StationsState> {
  const record = await chrome.storage.local.get([STATIONS_KEY, LEGACY_AUTH_KEY]);
  const state = record[STATIONS_KEY] as StationsState | undefined;
  if (state) return state;
  const legacy = record[LEGACY_AUTH_KEY] as LegacyStoredAuth | undefined;
  if (legacy) {
    const migrated = migrateLegacyAuth(legacy);
    await chrome.storage.local.set({ [STATIONS_KEY]: migrated });
    await chrome.storage.local.remove(LEGACY_AUTH_KEY);
    return migrated;
  }
  return EMPTY_STATE;
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
 * one just switches to it (keeping its saved session).
 */
export async function addStation(baseUrl: string, name?: string): Promise<Station> {
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

/** Remove a station; if it was active, the first remaining one takes over. */
export async function removeStation(id: string): Promise<void> {
  const state = await getStations();
  const stations = state.stations.filter((s) => s.id !== id);
  const activeId = state.activeId === id ? (stations[0]?.id ?? null) : state.activeId;
  await setStations({ stations, activeId });
}

export async function setActiveStation(id: string): Promise<void> {
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
