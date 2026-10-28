/**
 * Station registry (Zustand) — saved connections to self-hosted Greenhouse
 * deployments. Exactly one station is active; every API call resolves its
 * origin at call time via getApiBase(). Tokens live per station in
 * token-storage, so switching keeps each deployment's session.
 *
 * Every change of the active station repoints the token mirror first
 * (`detachTokens`, synchronously, before the `set` its subscribers react to):
 * the moment getApiBase() answers with the new origin, getAccessToken() holds
 * that station's token or none — never the previous station's. Callers then
 * load the new pair (auth.switchStation → bootstrap → hydrateTokens).
 *
 * First-launch seeding: the build's default stations (STATIONS.defaults, from
 * EXPO_PUBLIC_API_BASE_URL) are seeded signed-out with the first one active.
 * With no defaults, only __DEV__ seeds a station built from DEFAULT_API_BASE —
 * the generic store build starts empty and the user adds their server.
 *
 * Single-station builds (IS_SINGLE_STATION): the registry is locked to the
 * default station — hydrate() re-locks it on every run and add / switchTo /
 * remove ignore everything else, so no UI path can leave that server.
 */

import { create } from 'zustand';
import { checkAborted, withConnectionDeadline } from '../api/connection-deadline';
import { apiMismatch, parseBootstrap, type ApiMismatch } from '../api/bootstrap';
import { DEFAULT_API_BASE, IS_SINGLE_STATION, STATIONS } from '../config';
import type { StationConfig } from '../shared/greenhouse-config';
import { detachTokens, loadPref, savePref, purgeStationTokens } from '../api/token-storage';
import { forgetMember } from '../data/disk-cache';

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

async function getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  try {
    checkAborted(signal);
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** What a station's preflight found: a Greenhouse that speaks this app's API, or why not. */
export type StationProbe =
  | { ok: true; productName?: string }
  /** `server_outdated`: below the API level this app needs. */
  | { ok: false; mismatch?: ApiMismatch };

/**
 * Is there a Greenhouse at this origin that speaks this app's API? (no auth needed)
 *
 * `GET /api/bootstrap` is the public, side-effect-free pre-sign-in endpoint: its `mobile_api`
 * says which API level the server offers (../api/bootstrap.ts) and its `product_name` doubles as a
 * default station name. One connection budget covers the request and its body.
 */
export async function probeStation(baseUrl: string): Promise<StationProbe> {
  return withConnectionDeadline(async (signal): Promise<StationProbe> => {
    const boot = await getJson(`${baseUrl}/api/bootstrap`, signal);
    const mismatch = apiMismatch(boot);
    if (mismatch) return { ok: false, mismatch };
    const parsed = parseBootstrap(boot);
    if (!parsed) return { ok: false };
    return { ok: true, productName: parsed.product_name?.trim() || undefined };
  }).catch((): StationProbe => ({ ok: false }));
}

/** Signed-out record for a configured default: config id, normalized origin. */
function seedRecord(d: StationConfig): StationRecord {
  const baseUrl = normalizeBaseUrl(d.url) ?? d.url;
  return { id: d.id, baseUrl, name: d.name.trim() || hostLabel(baseUrl) };
}

/** The one station a single-station build is locked to (null otherwise). */
function lockedStation(): StationRecord | null {
  const first = STATIONS.defaults[0];
  return IS_SINGLE_STATION && first ? seedRecord(first) : null;
}

interface StationsState {
  stations: StationRecord[];
  activeId: string | null;
  hydrated: boolean;
  /** Load the persisted registry (with first-launch seeding / single-station lock). */
  hydrate: (signal?: AbortSignal) => Promise<void>;
  /** Save a station and make it active; a duplicate origin switches instead. Locked builds ignore other origins. */
  add: (baseUrl: string, name?: string) => Promise<StationRecord>;
  /** Make a station active. No-op in a locked build. */
  switchTo: (id: string) => Promise<void>;
  /** Delete the entry, its persisted tokens and offline copies; active falls to the first remaining. No-op in a locked build. */
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
  await Promise.all([savePref(STATIONS_PREF, JSON.stringify(stations)), savePref(ACTIVE_PREF, activeId)]);
}

export const useStations = create<StationsState>((set, get) => ({
  stations: [],
  activeId: null,
  hydrated: false,

  async hydrate(signal) {
    if (get().hydrated) return;
    const [rawList, rawActive] = await Promise.all([loadPref(STATIONS_PREF), loadPref(ACTIVE_PREF)]);
    checkAborted(signal);
    let stations = safeParseStations(rawList);
    let activeId = rawActive;

    if (!stations) {
      // First launch on this install: seed the build's defaults, first one active (a dev build
      // without any gets one for the build default).
      stations = STATIONS.defaults.map(seedRecord);
      if (stations.length === 0 && __DEV__) {
        stations = [{ id: newStationId(), baseUrl: DEFAULT_API_BASE, name: hostLabel(DEFAULT_API_BASE) }];
      }
      activeId = stations[0]?.id ?? null;
      await persist(stations, activeId);
    }

    const locked = lockedStation();
    if (locked) {
      // Single-station build: the registry holds exactly the locked station. An
      // entry with the same origin keeps its id (and so its tokens); anything else
      // is unreachable in this build and goes, tokens included.
      const existing = stations.find((s) => s.baseUrl === locked.baseUrl);
      const station = existing ? { ...existing, name: locked.name } : locked;
      const alreadyLocked =
        stations.length === 1 &&
        stations[0].id === station.id &&
        stations[0].name === station.name &&
        activeId === station.id;
      if (!alreadyLocked) {
        for (const s of stations) if (s.id !== station.id) purgeStationTokens(s.id);
        stations = [station];
        activeId = station.id;
        await persist(stations, activeId);
      }
    }

    if (activeId && !stations.some((s) => s.id === activeId)) activeId = stations[0]?.id ?? null;
    checkAborted(signal);
    detachTokens(activeId);
    set({ stations, activeId, hydrated: true });
  },

  async add(baseUrl, name) {
    const { stations } = get();
    const locked = lockedStation();
    if (locked && baseUrl !== locked.baseUrl) {
      return stations.find((s) => s.baseUrl === locked.baseUrl) ?? locked;
    }
    const existing = stations.find((s) => s.baseUrl === baseUrl);
    if (existing) {
      await get().switchTo(existing.id);
      return existing;
    }
    const station: StationRecord = { id: newStationId(), baseUrl, name: name?.trim() || hostLabel(baseUrl) };
    const next = [...stations, station];
    detachTokens(station.id);
    set({ stations: next, activeId: station.id });
    await persist(next, station.id);
    return station;
  },

  async switchTo(id) {
    if (IS_SINGLE_STATION) return;
    const { stations, activeId } = get();
    if (activeId === id || !stations.some((s) => s.id === id)) return;
    detachTokens(id);
    set({ activeId: id });
    await savePref(ACTIVE_PREF, id);
  },

  async remove(id) {
    if (IS_SINGLE_STATION) return;
    const { stations, activeId } = get();
    const next = stations.filter((s) => s.id !== id);
    const nextActive = activeId === id ? (next[0]?.id ?? null) : activeId;
    purgeStationTokens(id);
    // the offline copies of every member of that station go with it
    forgetMember(id);
    if (nextActive !== activeId) detachTokens(nextActive);
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
