import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_MANIFEST, parseManifest, type ManifestState } from '../plugins/manifest';

const test = vi.hoisted(() => {
  function store<S>(initial: S) {
    let state = initial;
    const listeners = new Set<(state: S, previous: S) => void>();
    return {
      getState: () => state,
      setState(next: S) {
        const previous = state;
        state = next;
        for (const listener of listeners) listener(state, previous);
      },
      subscribe(listener: (state: S, previous: S) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reset(next: S) {
        listeners.clear();
        state = next;
      },
    };
  }
  return {
    auth: store({ user: null as { id: string } | null }),
    stations: store({ activeId: 'station' }),
    manifest: store({ data: { kind: 'pending' } as ManifestState, status: 'idle' }),
    platform: { OS: 'ios' },
    foreground: null as null | ((state: string) => void),
    gantt: vi.fn(),
    removeOffline: vi.fn(),
    writeOffline: vi.fn(),
  };
});

vi.mock('react-native', () => ({
  Platform: test.platform,
  AppState: {
    addEventListener: (_event: string, callback: (state: string) => void) => {
      test.foreground = callback;
    },
  },
}));
vi.mock('../../modules/widget-bridge', () => ({ setWidgetSnapshot: vi.fn() }));
vi.mock('../api/projects', () => ({ gantt: test.gantt }));
vi.mock('../store/auth', () => ({ useAuth: test.auth }));
vi.mock('../store/stations', () => ({
  useStations: test.stations,
  getActiveStation: () => ({ id: 'station', name: 'Station' }),
}));
vi.mock('../plugins/store', () => ({ useStationManifest: test.manifest }));
vi.mock('../store/prefs', () => ({ usePrefs: { getState: () => ({ lang: 'en' }), subscribe: vi.fn() } }));
vi.mock('../store/knowledge', () => ({ recentDocs: async () => [] }));
vi.mock('../store/offline-events', () => ({ onOfflineChanged: vi.fn() }));
vi.mock('../store/offline', () => ({
  readOffline: async () => null,
  removeOffline: test.removeOffline,
  writeOffline: test.writeOffline,
}));

const manifest = (projects: boolean) =>
  parseManifest({
    manifest_version: 2,
    core: { version: '4.0.0', client_api: 4 },
    plugins: projects ? [{ id: 'projects', nav: [], pages: [] }] : [],
  });

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  test.auth.reset({ user: null });
  test.stations.reset({ activeId: 'station' });
  test.manifest.reset({ data: PENDING_MANIFEST, status: 'idle' });
  test.platform.OS = 'ios';
  test.gantt.mockResolvedValue({ ok: false, status: 503 });
  await import('./publish');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('widget startup and foreground requests', () => {
  it('waits for discovery at sign-in and clears disabled Projects without requesting them', () => {
    test.auth.setState({ user: { id: 'member' } });
    test.foreground?.('active');
    expect(test.gantt).not.toHaveBeenCalled();
    test.manifest.setState({ data: manifest(false), status: 'ready' });
    expect(test.removeOffline).toHaveBeenCalledWith('my-tasks');
    test.foreground?.('active');
    expect(test.gantt).not.toHaveBeenCalled();
  });

  it('refreshes once discovery permits native tasks', () => {
    test.auth.setState({ user: { id: 'member' } });
    test.manifest.setState({ data: manifest(true), status: 'ready' });
    expect(test.gantt).toHaveBeenCalledTimes(1);
    test.foreground?.('active');
    expect(test.gantt).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60_000);
    test.foreground?.('active');
    expect(test.gantt).toHaveBeenCalledTimes(2);
  });

  it('never refreshes on web and still clears a disabled plugin’s saved tasks', () => {
    test.platform.OS = 'web';
    test.auth.setState({ user: { id: 'member' } });
    test.manifest.setState({ data: manifest(true), status: 'ready' });
    test.foreground?.('active');
    test.foreground?.('active');
    test.manifest.setState({ data: manifest(false), status: 'ready' });
    expect(test.removeOffline).toHaveBeenCalledWith('my-tasks');
    expect(test.gantt).not.toHaveBeenCalled();
  });

  it('does not read tasks while discovery failed', () => {
    test.auth.setState({ user: { id: 'member' } });
    test.manifest.setState({ data: PENDING_MANIFEST, status: 'error' });
    test.foreground?.('active');
    expect(test.gantt).not.toHaveBeenCalled();
  });

  it('drops a late task response after Projects disappears', async () => {
    let resolve!: (value: unknown) => void;
    test.gantt.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    test.auth.setState({ user: { id: 'member' } });
    test.manifest.setState({ data: manifest(true), status: 'ready' });
    test.manifest.setState({ data: manifest(false), status: 'ready' });
    resolve({ ok: true, data: { projects: [] } });
    await Promise.resolve();
    expect(test.writeOffline).not.toHaveBeenCalled();
    expect(test.removeOffline).toHaveBeenCalledWith('my-tasks');
  });
});
