/**
 * Station registry (Zustand) — saved connections to self-hosted Greenhouse
 * deployments. Exactly one station is active; every API call resolves its
 * origin at call time via getApiBase(). Tokens live per station in
 * token-storage, so switching keeps each deployment's session.
 *
 * First-launch seeding: a legacy (pre-station) signed-in session is adopted
 * onto a station built from DEFAULT_API_BASE; otherwise a signed-out default
 * station is seeded only for pinned builds (EXPO_PUBLIC_API_BASE_URL set) and
 * dev. The generic store build starts empty and the user adds their server.
 */

import { create } from 'zustand';
import { DEFAULT_API_BASE, HAS_PINNED_BASE } from '../config';
import { loadPref, savePref, migrateLegacyTokens, purgeStationTokens } from '../api/token-storage';

export interface StationRecord {
  id: string;
  /** Normalized origin, no trailing slash. */
  baseUrl: string;
  /** Display name; defaults to the host. */
  name: string;
}

const STATIONS_PREF = 'stations';
const ACTIVE_PREF = 'active_station';

function newStationId(): string {
  return `st-${Math.random().toString(36).slice(2, 10)}`;
}

/** Host shown as the default station name. */
export function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

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
    const origin = new URL(withProto).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

function defaultScheme(input: string): 'http' | 'https' {
  const authority = input.split('/')[0];
  const host = authority.startsWith('[') ? authority : authority.split(':')[0];
  if (host === 'localhost' || host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'http';
  return 'https';
}

/** GET /api/auth/status — reachability + auth-enabled probe (no auth needed). */
export async function probeStation(baseUrl: string): Promise<{ ok: boolean; authEnabled?: boolean }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${baseUrl}/api/auth/status`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { authEnabled?: boolean };
    return { ok: typeof body.authEnabled === 'boolean', authEnabled: body.authEnabled };
  } catch {
    return { ok: false };
  }
}

interface StationsState {
  stations: StationRecord[];
  activeId: string | null;
  hydrated: boolean;
  /** Load the persisted registry (with legacy adoption / first-launch seeding). */
  hydrate: () => Promise<void>;
  /** Save a station and make it active; a duplicate origin switches instead. */
  add: (baseUrl: string, name?: string) => Promise<StationRecord>;
  switchTo: (id: string) => Promise<void>;
  /** Delete the entry and its persisted tokens; active falls to the first remaining. */
  remove: (id: string) => Promise<void>;
}

function safeParseStations(raw: string | null): StationRecord[] | null {
  if (!raw) return null;
  try {
    const list = JSON.parse(raw) as StationRecord[];
    return Array.isArray(list) ? list.filter((s) => s && s.id && s.baseUrl) : null;
  } catch {
    return null;
  }
}

async function persist(stations: StationRecord[], activeId: string | null): Promise<void> {
  await Promise.all([
    savePref(STATIONS_PREF, JSON.stringify(stations)),
    savePref(ACTIVE_PREF, activeId),
  ]);
}

export const useStations = create<StationsState>((set, get) => ({
  stations: [],
  activeId: null,
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    const [rawList, rawActive] = await Promise.all([loadPref(STATIONS_PREF), loadPref(ACTIVE_PREF)]);
    let stations = safeParseStations(rawList);
    let activeId = rawActive;

    if (!stations) {
      // First launch on this install.
      stations = [];
      activeId = null;
      const seed: StationRecord = {
        id: newStationId(),
        baseUrl: DEFAULT_API_BASE,
        name: hostLabel(DEFAULT_API_BASE),
      };
      const hadLegacySession = await migrateLegacyTokens(seed.id);
      if (hadLegacySession || HAS_PINNED_BASE || __DEV__) {
        stations = [seed];
        activeId = seed.id;
      }
      await persist(stations, activeId);
    }

    if (activeId && !stations.some((s) => s.id === activeId)) activeId = stations[0]?.id ?? null;
    set({ stations, activeId, hydrated: true });
  },

  async add(baseUrl, name) {
    const { stations } = get();
    const existing = stations.find((s) => s.baseUrl === baseUrl);
    if (existing) {
      await get().switchTo(existing.id);
      return existing;
    }
    const station: StationRecord = { id: newStationId(), baseUrl, name: name?.trim() || hostLabel(baseUrl) };
    const next = [...stations, station];
    set({ stations: next, activeId: station.id });
    await persist(next, station.id);
    return station;
  },

  async switchTo(id) {
    const { stations, activeId } = get();
    if (activeId === id || !stations.some((s) => s.id === id)) return;
    set({ activeId: id });
    await savePref(ACTIVE_PREF, id);
  },

  async remove(id) {
    const { stations, activeId } = get();
    const next = stations.filter((s) => s.id !== id);
    const nextActive = activeId === id ? (next[0]?.id ?? null) : activeId;
    purgeStationTokens(id);
    set({ stations: next, activeId: nextActive });
    await persist(next, nextActive);
  },
}));

/** Active station record, or null. */
export function getActiveStation(): StationRecord | null {
  const { stations, activeId } = useStations.getState();
  return stations.find((s) => s.id === activeId) ?? null;
}

/**
 * Origin all API calls go to — the active station's, falling back to the
 * build default before hydration / when the registry is empty (requests fail
 * fast there; the login gate keeps users out of that state).
 */
export function getApiBase(): string {
  return getActiveStation()?.baseUrl ?? DEFAULT_API_BASE;
}
