import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  station: 'station',
  access: 'old-access',
  refresh: 'old-refresh',
  hydrate: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../api/token-storage', () => ({
  getTokenStationId: () => state.station,
  getAccessToken: () => state.access,
  getRefreshToken: () => state.refresh,
  hydrateTokens: state.hydrate,
}));
vi.mock('../api/persistence.desktop', () => ({ flushCredentials: state.flush }));
import { withRefreshLock } from './refresh-lock.desktop';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  state.station = 'station';
  state.access = 'old-access';
  state.refresh = 'old-refresh';
});
it('reuses a rotation completed by another window while this one waits for the shared lock', async () => {
  let enter!: () => void;
  vi.stubGlobal('navigator', {
    locks: {
      request: (_key: string, run: () => Promise<boolean>) =>
        new Promise<boolean>((resolve) => {
          enter = () => void run().then(resolve);
        }),
    },
  });
  const rotate = vi.fn();
  const pending = withRefreshLock('station', rotate);
  state.hydrate.mockImplementationOnce(async () => {
    state.refresh = 'new-refresh';
    state.access = 'new-access';
  });
  enter();
  expect(await pending).toBe(true);
  expect(rotate).not.toHaveBeenCalled();
});
it('holds the lock until the new credentials are durably stored', async () => {
  const steps: string[] = [];
  vi.stubGlobal('navigator', {
    locks: {
      request: async (_key: string, run: () => Promise<boolean>) => {
        steps.push('locked');
        const value = await run();
        steps.push('unlocked');
        return value;
      },
    },
  });
  state.hydrate.mockResolvedValueOnce(undefined);
  state.flush.mockImplementationOnce(async () => {
    steps.push('saved');
  });
  expect(
    await withRefreshLock('station', async () => {
      steps.push('rotated');
      return true;
    }),
  ).toBe(true);
  expect(steps).toEqual(['locked', 'rotated', 'saved', 'unlocked']);
});
it('does not refresh after the active station changes while waiting', async () => {
  vi.stubGlobal('navigator', {
    locks: {
      request: async (_key: string, run: () => Promise<boolean>) => {
        state.station = 'other';
        return run();
      },
    },
  });
  const rotate = vi.fn();
  expect(await withRefreshLock('station', rotate)).toBe(false);
  expect(rotate).not.toHaveBeenCalled();
  expect(state.hydrate).not.toHaveBeenCalled();
});
