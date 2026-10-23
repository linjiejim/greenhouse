/**
 * The per-station push switch (./register.ts) against a registration still in flight: switching
 * pushes off must win whichever lands first — the PUT that registers this phone, or the switch.
 * Runs in the ROOT vitest unit project: react-native, expo-*, zustand, the API and the stores are
 * mocked (the app's own install is absent in CI).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const DEVICE = {
  id: 'pdv_1',
  platform: 'ios',
  client_ref: 'st-a',
  prefs: { needs_you: true, done: true, other: true, preview: false },
  created_at: '2026-10-23T00:00:00.000Z',
  last_seen_at: '2026-10-23T00:00:00.000Z',
};

const prefs = new Map<string, string>();
const calls: string[] = [];
let releasePut: (() => void) | null = null;
let unregisterOk = true;

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: { eas: { projectId: 'proj' } } } } }));
vi.mock('expo-notifications', () => ({
  IosAuthorizationStatus: { NOT_DETERMINED: 0, DENIED: 1, AUTHORIZED: 2 },
  getPermissionsAsync: async () => ({ ios: { status: 2 }, granted: true, status: 'granted' }),
  requestPermissionsAsync: async () => ({ ios: { status: 2 }, granted: true, status: 'granted' }),
  getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[abc]' }),
}));
vi.mock('zustand', () => ({
  create: <S extends object>(init: () => S) => {
    let state = init();
    const get = () => state;
    const set = (partial: Partial<S>) => {
      state = { ...state, ...partial };
    };
    return Object.assign(() => state, { getState: get, setState: set });
  },
}));
vi.mock('../store/auth', () => ({ useAuth: { getState: () => ({ user: { id: 'u1' }, loading: false, mismatch: null }) } }));
vi.mock('../store/stations', () => ({ useStations: { getState: () => ({ activeId: 'st-a', stations: [] }) } }));
vi.mock('../api/token-storage', () => ({
  loadPref: async (key: string) => prefs.get(key) ?? null,
  savePref: async (key: string, value: string | null) => {
    if (value === null) prefs.delete(key);
    else prefs.set(key, value);
  },
  readStationTokens: async () => ({ access: null, refresh: null }),
}));
vi.mock('../api/push', () => ({
  PUSH_DEVICES_PATH: '/api/auth/me/push-devices',
  listPushDevices: async () => ({ ok: true, data: { enabled: true, devices: [] } }),
  registerPushDevice: () => {
    calls.push('PUT');
    return new Promise((resolve) => {
      releasePut = () => {
        calls.push('PUT done');
        resolve({ ok: true, data: { enabled: true, device: DEVICE } });
      };
    });
  },
  unregisterPushDevice: async (id: string) => {
    calls.push(`DELETE ${id}`);
    return unregisterOk ? { ok: true, data: { ok: true } } : { ok: false, status: 0, code: 'network', message: '' };
  },
  updatePushPrefs: async () => ({ ok: true, data: { device: DEVICE } }),
}));

let setPushOff: typeof import('./register').setPushOff;
let syncPush: typeof import('./register').syncPush;
let usePush: typeof import('./register').usePush;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function untilPut() {
  for (let i = 0; i < 50 && !releasePut; i++) await tick();
}

beforeEach(async () => {
  // a fresh module per test: the switch's run state is module state
  vi.resetModules();
  ({ setPushOff, syncPush, usePush } = await import('./register'));
  prefs.clear();
  calls.length = 0;
  releasePut = null;
  unregisterOk = true;
  usePush.setState({ support: 'unknown', permission: 'undetermined', device: null, off: false, tokenFailed: false });
});

describe('switching pushes off during a registration', () => {
  it('takes back a registration whose PUT lands after the switch', async () => {
    const sync = syncPush();
    await untilPut();
    const off = setPushOff(true);
    releasePut!();
    await sync;
    expect(await off).toBe(true);
    expect(calls).toContain('DELETE pdv_1');
    expect(calls.indexOf('DELETE pdv_1')).toBeGreaterThan(calls.indexOf('PUT done'));
    expect(usePush.getState()).toMatchObject({ off: true, device: null });
  });

  it('unregisters a phone whose registration finished just before the switch', async () => {
    const sync = syncPush();
    await untilPut();
    releasePut!();
    await sync;
    expect(usePush.getState().device?.id).toBe('pdv_1');
    expect(await setPushOff(true)).toBe(true);
    expect(calls).toEqual(['PUT', 'PUT done', 'DELETE pdv_1']);
    expect(usePush.getState()).toMatchObject({ off: true, device: null });
  });

  it('puts the switch back on when the station cannot be told', async () => {
    const sync = syncPush();
    await untilPut();
    releasePut!();
    await sync;
    unregisterOk = false;
    expect(await setPushOff(true)).toBe(false);
    expect(usePush.getState()).toMatchObject({ off: false, device: { id: 'pdv_1' } });
  });
});
