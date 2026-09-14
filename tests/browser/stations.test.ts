/**
 * Station-registry tests for the extension storage layer — the multi-station
 * core: legacy single-slot migration, add/switch/remove semantics, per-station
 * session writes, and the build-time stations config (first-launch seeding,
 * single-station lock). chrome.storage.local is mocked in-memory; the config
 * module is mocked so every test picks its own mode / defaults.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientStationsConfig } from '@greenhouse/types/config';
import {
  addStation,
  getAuth,
  getStations,
  migrateLegacyAuth,
  normalizeBaseUrl,
  removeStation,
  setActiveStation,
  stationIdFor,
  updateStationAuth,
  type StationAuth,
} from '../../apps/browser/src/lib/storage';

// ─── Build-time config mock ──────────────────────────────

// Mutable so each test sets its own mode / defaults: the storage layer reads
// the config at call time, never at import.
const cfg = vi.hoisted((): ClientStationsConfig => ({ mode: 'multi', defaults: [] }));

vi.mock('../../apps/browser/src/config', () => ({
  get STATIONS() {
    return cfg;
  },
  isSingleStation: () => cfg.mode === 'single',
  defaultStations: () => cfg.defaults,
}));

// ─── chrome.storage.local mock ───────────────────────────

let store: Record<string, unknown>;

function installChromeMock() {
  store = {};
  const local = {
    async get(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (k in store) out[k] = structuredClone(store[k]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      Object.assign(store, structuredClone(items));
    },
    async remove(key: string) {
      delete store[key];
    },
  };
  (globalThis as Record<string, unknown>).chrome = {
    storage: { local, onChanged: { addListener() {}, removeListener() {} } },
  };
}

beforeEach(() => {
  installChromeMock();
  cfg.mode = 'multi';
  cfg.defaults = [];
});

const user = { id: 'u1', nickname: 'Kim', role: 'team' };
const AUTH_A: StationAuth = { accessToken: 'at-a', refreshToken: 'rt-a', user };

// ─── Legacy migration ────────────────────────────────────

describe('legacy auth migration', () => {
  const legacy = { baseUrl: 'https://gh.example.com', accessToken: 'at', refreshToken: 'rt', user };

  it('converts the single auth slot into a one-station registry and removes it', async () => {
    store.auth = legacy;
    const state = await getStations();
    expect(state.stations).toHaveLength(1);
    expect(state.stations[0]).toMatchObject({
      baseUrl: legacy.baseUrl,
      name: 'gh.example.com',
      auth: { accessToken: 'at', refreshToken: 'rt' },
    });
    expect(state.activeId).toBe(state.stations[0].id);
    expect(store.auth).toBeUndefined();
    expect(store.stations).toBeDefined();
  });

  it('is deterministic — two contexts migrating concurrently converge', () => {
    const a = migrateLegacyAuth(legacy);
    const b = migrateLegacyAuth(legacy);
    expect(a).toEqual(b);
    expect(a.stations[0].id).toBe(stationIdFor(legacy.baseUrl));
  });

  it('returns an empty registry when nothing is stored', async () => {
    expect(await getStations()).toEqual({ stations: [], activeId: null });
  });
});

// ─── Registry operations ─────────────────────────────────

describe('station registry', () => {
  it('addStation saves a signed-out station and makes it active', async () => {
    const st = await addStation('https://one.example.com');
    expect(st.auth).toBeNull();
    expect(st.name).toBe('one.example.com');
    const state = await getStations();
    expect(state.activeId).toBe(st.id);
  });

  it('adding a duplicate origin switches to the existing station instead', async () => {
    const one = await addStation('https://one.example.com');
    await updateStationAuth(one.id, AUTH_A);
    await addStation('https://two.example.com');

    const again = await addStation('https://one.example.com');
    expect(again.id).toBe(one.id);
    const state = await getStations();
    expect(state.stations).toHaveLength(2);
    expect(state.activeId).toBe(one.id);
    // The saved session survived the round-trip.
    expect(state.stations.find((s) => s.id === one.id)?.auth?.accessToken).toBe('at-a');
  });

  it('setActiveStation switches and ignores unknown ids', async () => {
    const one = await addStation('https://one.example.com');
    const two = await addStation('https://two.example.com');
    await setActiveStation(one.id);
    expect((await getStations()).activeId).toBe(one.id);
    await setActiveStation('st-nope');
    expect((await getStations()).activeId).toBe(one.id);
    await setActiveStation(two.id);
    expect((await getStations()).activeId).toBe(two.id);
  });

  it('removing the active station promotes the first remaining one', async () => {
    const one = await addStation('https://one.example.com');
    const two = await addStation('https://two.example.com');
    await removeStation(two.id);
    const state = await getStations();
    expect(state.stations.map((s) => s.id)).toEqual([one.id]);
    expect(state.activeId).toBe(one.id);
    await removeStation(one.id);
    expect(await getStations()).toEqual({ stations: [], activeId: null });
  });

  it('removing an inactive station keeps the active one', async () => {
    const one = await addStation('https://one.example.com');
    const two = await addStation('https://two.example.com');
    await removeStation(one.id);
    expect((await getStations()).activeId).toBe(two.id);
  });
});

// ─── Per-station sessions ────────────────────────────────

describe('station sessions', () => {
  it('updateStationAuth targets the given station, not the active one', async () => {
    const one = await addStation('https://one.example.com');
    await addStation('https://two.example.com'); // two is now active
    await updateStationAuth(one.id, AUTH_A);

    const state = await getStations();
    expect(state.stations.find((s) => s.id === one.id)?.auth).toEqual(AUTH_A);
    expect(state.stations.find((s) => s.baseUrl.includes('two'))?.auth).toBeNull();
  });

  it('signing out clears the session but keeps the registry entry', async () => {
    const one = await addStation('https://one.example.com');
    await updateStationAuth(one.id, AUTH_A);
    await updateStationAuth(one.id, null);
    const state = await getStations();
    expect(state.stations).toHaveLength(1);
    expect(state.stations[0].auth).toBeNull();
  });

  it('is a no-op for a station removed meanwhile', async () => {
    const one = await addStation('https://one.example.com');
    await removeStation(one.id);
    await updateStationAuth(one.id, AUTH_A);
    expect(await getStations()).toEqual({ stations: [], activeId: null });
  });

  it('getAuth flattens only a signed-in active station', async () => {
    expect(await getAuth()).toBeNull();
    const one = await addStation('https://one.example.com');
    expect(await getAuth()).toBeNull(); // signed out
    await updateStationAuth(one.id, AUTH_A);
    expect(await getAuth()).toMatchObject({
      stationId: one.id,
      baseUrl: 'https://one.example.com',
      accessToken: 'at-a',
    });
    // A signed-out station elsewhere never leaks through.
    const two = await addStation('https://two.example.com');
    expect(await getAuth()).toBeNull();
    await removeStation(two.id);
    expect((await getAuth())?.stationId).toBe(one.id);
  });
});

// ─── Configured defaults (greenhouse.config.ts → clients.stations) ─

const HQ = { id: 'hq', name: 'HQ', url: 'https://hq.example.com/' };
const LAB = { id: 'lab', name: 'Lab', url: 'lab.example.com' };
const HQ_ID = stationIdFor('https://hq.example.com');

describe('configured default stations', () => {
  it('seeds the defaults on first launch — origins normalized, first one active, persisted once', async () => {
    cfg.defaults = [HQ, LAB];
    const state = await getStations();
    expect(state.stations).toEqual([
      { id: HQ_ID, baseUrl: 'https://hq.example.com', name: 'HQ', auth: null },
      { id: stationIdFor('https://lab.example.com'), baseUrl: 'https://lab.example.com', name: 'Lab', auth: null },
    ]);
    expect(state.activeId).toBe(HQ_ID);
    expect(store.stations).toEqual(state);
    // Seeding happened on the first read, not on every read.
    cfg.defaults = [];
    expect(await getStations()).toEqual(state);
  });

  it('does not seed when a legacy auth slot is migrated instead', async () => {
    cfg.defaults = [HQ];
    store.auth = { baseUrl: 'https://gh.example.com', accessToken: 'at', refreshToken: 'rt', user };
    const state = await getStations();
    expect(state.stations.map((s) => s.baseUrl)).toEqual(['https://gh.example.com']);
    expect(store.auth).toBeUndefined();
  });

  it('leaves a registry the user emptied alone', async () => {
    cfg.defaults = [HQ];
    store.stations = { stations: [], activeId: null };
    expect(await getStations()).toEqual({ stations: [], activeId: null });
  });

  it('seeded stations behave like any other (removable, switchable)', async () => {
    cfg.defaults = [HQ, LAB];
    await removeStation(HQ_ID);
    const state = await getStations();
    expect(state.stations.map((s) => s.name)).toEqual(['Lab']);
    expect(state.activeId).toBe(state.stations[0].id);
  });
});

// ─── Single-station build ────────────────────────────────

describe('single-station build', () => {
  beforeEach(() => {
    cfg.mode = 'single';
    cfg.defaults = [HQ];
  });

  it('holds exactly the locked station, active', async () => {
    expect(await getStations()).toEqual({
      stations: [{ id: HQ_ID, baseUrl: 'https://hq.example.com', name: 'HQ', auth: null }],
      activeId: HQ_ID,
    });
  });

  it('refuses a foreign origin and keeps accepting the locked one', async () => {
    await expect(addStation('https://other.example.com')).rejects.toThrow(/locked to HQ/);
    expect((await getStations()).stations.map((s) => s.baseUrl)).toEqual(['https://hq.example.com']);
    expect((await addStation('https://hq.example.com')).id).toBe(HQ_ID);
  });

  it('ignores remove and switch', async () => {
    await removeStation(HQ_ID);
    await setActiveStation('st-nope');
    const state = await getStations();
    expect(state.stations.map((s) => s.id)).toEqual([HQ_ID]);
    expect(state.activeId).toBe(HQ_ID);
  });

  it('still signs the locked station in and out', async () => {
    await updateStationAuth(HQ_ID, AUTH_A);
    expect((await getAuth())?.stationId).toBe(HQ_ID);
    await updateStationAuth(HQ_ID, null);
    expect(await getAuth()).toBeNull();
    expect((await getStations()).stations).toHaveLength(1);
  });

  it('re-locks a registry left by a multi-station build, keeping the locked station session', async () => {
    const other = {
      id: stationIdFor('https://other.example.com'),
      baseUrl: 'https://other.example.com',
      name: 'other.example.com',
      auth: AUTH_A,
    };
    const hq = {
      id: HQ_ID,
      baseUrl: 'https://hq.example.com',
      name: 'hq.example.com',
      auth: { ...AUTH_A, accessToken: 'at-hq' },
    };
    store.stations = { stations: [other, hq], activeId: other.id };

    const state = await getStations();
    expect(state).toEqual({ stations: [{ ...hq, name: 'HQ' }], activeId: HQ_ID });
    expect(store.stations).toEqual(state);
    expect((await getAuth())?.accessToken).toBe('at-hq');
  });
});

// ─── URL normalization ───────────────────────────────────

describe('normalizeBaseUrl', () => {
  it('defaults domains to https and strips path/slash', () => {
    expect(normalizeBaseUrl('greenhouse.example.com')).toBe('https://greenhouse.example.com');
    expect(normalizeBaseUrl('https://gh.example.com/app/')).toBe('https://gh.example.com');
  });

  it('defaults bare IPs and localhost to http (LAN self-hosts)', () => {
    expect(normalizeBaseUrl('192.168.1.10:3000')).toBe('http://192.168.1.10:3000');
    expect(normalizeBaseUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeBaseUrl('[::1]:3000')).toBe('http://[::1]:3000');
  });

  it('keeps an explicit scheme', () => {
    expect(normalizeBaseUrl('http://gh.example.com')).toBe('http://gh.example.com');
    expect(normalizeBaseUrl('https://192.168.1.10')).toBe('https://192.168.1.10');
  });

  it('rejects unusable input', () => {
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl('   ')).toBeNull();
    expect(normalizeBaseUrl('http://')).toBeNull();
  });
});
