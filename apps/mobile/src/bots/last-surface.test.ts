/**
 * What a cold start can open without the network (./last-surface.ts): the last thread and the
 * main thread (Sprouty's DM), remembered per station + account in the real prefs store
 * (../store/prefs.ts). Runs in the ROOT vitest unit project: zustand (absent from the root
 * install in CI), the pref storage, the station registry and auth are mocked — the
 * src/store/auth.test.ts pattern.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  stationId: 'st1' as string | null,
  userId: 'u1' as string | null,
  /** The persisted prefs (SecureStore on device). */
  stored: new Map<string, string>(),
  writes: [] as Array<[string, string | null]>,
}));

// A minimal zustand `create`: state + set/get/getState/setState (all the prefs store needs).
vi.mock('zustand', () => ({
  create: <S extends object>(init: (set: (p: Partial<S>) => void, get: () => S) => S) => {
    let state: S;
    const get = () => state;
    const set = (partial: Partial<S>) => {
      state = { ...state, ...partial };
    };
    state = init(set, get);
    return Object.assign(() => state, { getState: get, setState: set });
  },
}));
vi.mock('../api/token-storage', () => ({
  loadPref: async (key: string) => env.stored.get(key) ?? null,
  savePref: async (key: string, value: string | null) => {
    env.writes.push([key, value]);
    if (value === null) env.stored.delete(key);
    else env.stored.set(key, value);
  },
}));
vi.mock('../store/stations', () => ({ useStations: { getState: () => ({ activeId: env.stationId }) } }));
vi.mock('../store/auth', () => ({
  useAuth: { getState: () => ({ user: env.userId ? { id: env.userId } : null }) },
}));

const { usePrefs } = await import('../store/prefs');
const { forgetGoneThread, forgetThread, lastThread, mainThread, rememberMainThread, rememberThread } = await import(
  './last-surface'
);

const MAIN = { c: 'sess_sprouty', title: 'Sprouty' };
const FERN = { c: 'sess_fern', title: 'Fern' };

beforeEach(() => {
  env.stationId = 'st1';
  env.userId = 'u1';
  env.stored.clear();
  env.writes.length = 0;
  usePrefs.setState({ hydrated: false, lastThreads: {}, mainThreads: {} });
});

describe('the main thread', () => {
  it('is unknown until prefs are read, then read per station + account', async () => {
    env.stored.set('mainThreads', JSON.stringify({ 'st1:u1': MAIN, 'st2:u1': { c: 'sess_b', title: 'Sprouty' } }));
    expect(mainThread()).toBeNull();
    await usePrefs.getState().hydrate();
    expect(mainThread()).toEqual(MAIN);
    env.stationId = 'st2';
    expect(mainThread()).toEqual({ c: 'sess_b', title: 'Sprouty' });
    env.userId = 'u2';
    expect(mainThread()).toBeNull();
    env.userId = null;
    expect(mainThread()).toBeNull();
  });

  it('is remembered and persisted for this station + account, written only when it changes', async () => {
    await usePrefs.getState().hydrate();
    rememberMainThread(MAIN);
    expect(mainThread()).toEqual(MAIN);
    expect(JSON.parse(env.stored.get('mainThreads') ?? 'null')).toEqual({ 'st1:u1': MAIN });

    const writes = env.writes.length;
    rememberMainThread(MAIN);
    expect(env.writes).toHaveLength(writes);

    // Sprouty renamed: the placeholder title follows
    rememberMainThread({ ...MAIN, title: 'Sprig' });
    expect(mainThread()).toEqual({ c: 'sess_sprouty', title: 'Sprig' });
    // another account on the same station has its own
    env.userId = 'u2';
    expect(mainThread()).toBeNull();
  });

  it('remembers nothing without a station, an account or a thread id', async () => {
    await usePrefs.getState().hydrate();
    env.stationId = null;
    rememberMainThread(MAIN);
    env.stationId = 'st1';
    env.userId = null;
    rememberMainThread(MAIN);
    env.userId = 'u1';
    rememberMainThread({ c: '', title: 'Sprouty' });
    expect(mainThread()).toBeNull();
    expect(env.writes).toEqual([]);
  });

  it('stays when the member moves to a chat — only the last thread is forgotten', async () => {
    await usePrefs.getState().hydrate();
    rememberThread(FERN);
    rememberMainThread(MAIN);
    forgetThread();
    expect(lastThread()).toBeNull();
    expect(mainThread()).toEqual(MAIN);
  });

  it('is dropped when it is the thread found gone (404 / 403), kept when another one is', async () => {
    await usePrefs.getState().hydrate();
    rememberMainThread(MAIN);
    rememberThread(FERN);
    forgetGoneThread(FERN.c);
    expect(lastThread()).toBeNull();
    expect(mainThread()).toEqual(MAIN);

    rememberThread(MAIN);
    forgetGoneThread(MAIN.c);
    expect(lastThread()).toBeNull();
    expect(mainThread()).toBeNull();
    // an empty map is deleted, not stored
    expect(env.stored.has('mainThreads')).toBe(false);
    expect(env.stored.has('lastThreads')).toBe(false);
  });

  it('keeps the last and the main thread apart in storage', async () => {
    env.stored.set('lastThreads', JSON.stringify({ 'st1:u1': FERN }));
    env.stored.set('mainThreads', JSON.stringify({ 'st1:u1': MAIN }));
    await usePrefs.getState().hydrate();
    expect(lastThread()).toEqual(FERN);
    expect(mainThread()).toEqual(MAIN);
  });

  it('reads a corrupt or malformed stored map as empty', async () => {
    env.stored.set('mainThreads', '{not json');
    await usePrefs.getState().hydrate();
    expect(mainThread()).toBeNull();

    env.stored.set('mainThreads', JSON.stringify({ 'st1:u1': { c: 5, title: 'Sprouty' }, 'st2:u1': null }));
    await usePrefs.getState().hydrate();
    expect(mainThread()).toBeNull();
  });

  it('keeps the 8 most recent station + account entries', async () => {
    await usePrefs.getState().hydrate();
    for (let i = 0; i < 9; i += 1) {
      env.stationId = `st${i}`;
      rememberMainThread({ c: `sess_${i}`, title: 'Sprouty' });
    }
    const stored = JSON.parse(env.stored.get('mainThreads') ?? '{}') as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(8);
    expect(stored['st0:u1']).toBeUndefined();
    expect(stored['st8:u1']).toEqual({ c: 'sess_8', title: 'Sprouty' });
  });
});
