/**
 * `useAuth.switchStation` (./auth.ts): `loading` goes up before the registry change runs — so
 * nothing gated on it (the screens, the Bots gate and socket) renders against the new station
 * with the old one's session — and stays up until the bootstrap that follows lowers it, even
 * when an earlier bootstrap finishes in between. Runs in the ROOT vitest unit project: zustand
 * (absent from the root install in CI), the station registry, the token mirror and the auth API
 * are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type User = { id: string };

// A minimal zustand `create`: state + set/get/getState/setState (all switchStation needs).
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

const log: string[] = [];
let validate: () => Promise<User | null> = async () => ({ id: 'u-b' });

vi.mock('./stations', () => ({
  useStations: { getState: () => ({ hydrate: async () => {}, activeId: 'b' }) },
}));
vi.mock('../api/token-storage', () => ({
  hydrateTokens: async (sid: string | null) => {
    log.push(`hydrate:${sid}`);
  },
  getCachedUser: () => null,
  getAccessToken: () => 'token',
}));
vi.mock('../api/auth', () => ({
  validateSession: () => validate(),
  login: async () => ({ ok: false }),
  logout: () => {},
}));

const { useAuth, STARTUP_CONNECTION_TIMEOUT_MS } = await import('./auth');

beforeEach(() => {
  log.length = 0;
  validate = async () => ({ id: 'u-b' });
  useAuth.setState({ user: { id: 'u-a' } as never, loading: false });
});

describe('switchStation', () => {
  it('raises loading before the change runs, then bootstraps the new station', async () => {
    const done = useAuth.getState().switchStation(async () => {
      log.push(`change:loading=${useAuth.getState().loading}`);
    });
    // Synchronously: up already, and the change has started under it.
    expect(useAuth.getState().loading).toBe(true);
    await done;
    expect(log).toEqual(['change:loading=true', 'hydrate:b']);
    expect(useAuth.getState()).toMatchObject({ loading: false, user: { id: 'u-b' } });
  });

  it('settles a failed registry mutation as a recoverable error', async () => {
    await expect(
      useAuth.getState().switchStation(async () => {
        throw new Error('persist failed');
      }),
    ).resolves.toBeUndefined();
    expect(log).toEqual([]);
    expect(useAuth.getState()).toMatchObject({ loading: false, user: null, startupError: 'connection' });
  });

  it('an earlier bootstrap finishing mid-switch does not lower loading', async () => {
    let releaseFirst!: (user: User | null) => void;
    validate = () => new Promise<User | null>((resolve) => (releaseFirst = resolve));
    const first = useAuth.getState().bootstrap();
    // Let the first bootstrap reach its validate call.
    await vi.waitFor(() => expect(log).toEqual(['hydrate:b']));

    let loadingAfterStaleBoot: boolean | null = null;
    validate = async () => ({ id: 'u-b' });
    const switching = useAuth.getState().switchStation(async () => {
      releaseFirst({ id: 'u-a' });
      await first;
      loadingAfterStaleBoot = useAuth.getState().loading;
    });
    await switching;
    expect(loadingAfterStaleBoot).toBe(true);
    expect(useAuth.getState()).toMatchObject({ loading: false, user: { id: 'u-b' } });
  });
});

afterEach(() => vi.useRealTimers());

describe('startup deadline', () => {
  it('reserves native rendering time inside the 10-second visible limit', () => {
    expect(STARTUP_CONNECTION_TIMEOUT_MS).toBeLessThanOrEqual(8500);
  });
  it('releases loading with time left for native recovery UI even when validation ignores abort, and ignores its late answer', async () => {
    vi.useFakeTimers();
    let release!: (user: User | null) => void;
    validate = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const boot = useAuth.getState().bootstrap();
    await vi.advanceTimersByTimeAsync(STARTUP_CONNECTION_TIMEOUT_MS - 1);
    expect(useAuth.getState().loading).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await boot;
    expect(useAuth.getState()).toMatchObject({ loading: false, user: null, startupError: 'timeout' });
    validate = async () => ({ id: 'new-user' });
    await useAuth.getState().bootstrap();
    release({ id: 'late-user' });
    await vi.advanceTimersByTimeAsync(0);
    expect(useAuth.getState()).toMatchObject({ loading: false, user: { id: 'new-user' }, startupError: null });
  });

  it('includes the registry mutation in the same startup budget', async () => {
    vi.useFakeTimers();
    const boot = useAuth.getState().switchStation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(STARTUP_CONNECTION_TIMEOUT_MS);
    await boot;
    expect(useAuth.getState()).toMatchObject({ loading: false, user: null, startupError: 'timeout' });
    expect(log).toEqual([]);
  });

  it('reports network errors immediately and lets a retry recover', async () => {
    validate = async () => {
      throw new Error('offline');
    };
    await useAuth.getState().bootstrap();
    expect(useAuth.getState()).toMatchObject({ loading: false, user: null, startupError: 'connection' });
    validate = async () => ({ id: 'u-b' });
    await useAuth.getState().bootstrap();
    expect(useAuth.getState()).toMatchObject({ loading: false, user: { id: 'u-b' }, startupError: null });
  });
});


it('profile updates during startup do not bypass session validation', async () => {
  vi.useFakeTimers();
  validate = () => new Promise(() => {});
  const boot = useAuth.getState().bootstrap();
  await vi.advanceTimersByTimeAsync(0);
  useAuth.getState().setUser({ id: 'u-b', locale: 'zh' } as never);
  expect(useAuth.getState().loading).toBe(true);
  await vi.advanceTimersByTimeAsync(STARTUP_CONNECTION_TIMEOUT_MS);
  await boot;
  expect(useAuth.getState()).toMatchObject({ loading: false, user: null, startupError: 'timeout' });
});
