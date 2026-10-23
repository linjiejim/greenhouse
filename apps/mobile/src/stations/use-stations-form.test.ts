import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  change: vi.fn(),
  switchTo: vi.fn(),
  alert: vi.fn(),
  leave: vi.fn(),
  done: vi.fn(),
  cleanup: (() => {}) as () => void,
}));
// Exercise the hook's commands without native views; refs retain their synchronous lock.
vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useState: (value: unknown) => [value, () => {}],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => () => void) => {
    mocks.cleanup = effect();
  },
}));
vi.mock('../config', () => ({ IS_SINGLE_STATION: false }));
vi.mock('../store/stations', () => {
  const state = {
    stations: [{ id: 'a', baseUrl: 'https://a.example', name: 'A' }],
    activeId: 'a',
    switchTo: mocks.switchTo,
  };
  return {
    useStations: Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state }),
    probeStation: mocks.probe,
    normalizeBaseUrl: (url: string) => url,
  };
});
vi.mock('../store/auth', () => ({
  AFTER_DISMISS_MS: 380,
  useAuth: { getState: () => ({ switchStation: mocks.change }) },
}));
vi.mock('../lib/i18n', () => ({ useT: () => (key: string) => key }));
vi.mock('../ui/dialogs', () => ({ alertError: mocks.alert, confirmAction: vi.fn() }));
vi.mock('../push/register', () => ({ unregisterActive: vi.fn(), unregisterStation: vi.fn() }));
const { useStationsForm } = await import('./use-stations-form');
const target = { id: 'b', baseUrl: 'https://b.example', name: 'B' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.change.mockImplementation((change: () => Promise<unknown>) => change());
});
afterEach(() => vi.useRealTimers());

describe('switch preflight', () => {
  it('keeps the current station and sheet when the target is unreachable', async () => {
    mocks.probe.mockResolvedValue({ ok: false });
    const form = useStationsForm({ onDone: mocks.done, onLeave: mocks.leave });
    await form.select(target);
    expect(mocks.alert).toHaveBeenCalledWith('station.switchFailed', 'station.unreachable');
    expect(mocks.leave).not.toHaveBeenCalled();
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it('rejects rapid duplicate taps and switches only after a successful probe and dismissal', async () => {
    let resolve!: (value: unknown) => void;
    mocks.probe.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const form = useStationsForm({ onDone: mocks.done, onLeave: mocks.leave });
    const first = form.select(target);
    await form.select(target);
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    expect(mocks.leave).not.toHaveBeenCalled();
    resolve({ ok: true, authEnabled: true });
    await first;
    expect(mocks.leave).toHaveBeenCalledTimes(1);
    expect(mocks.change).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(380);
    expect(mocks.switchTo).toHaveBeenCalledWith('b');
  });

  it('does not switch after the member dismisses the form while probing', async () => {
    let resolve!: (value: unknown) => void;
    mocks.probe.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const form = useStationsForm({ onDone: mocks.done, onLeave: mocks.leave });
    const selecting = form.select(target);
    mocks.cleanup();
    resolve({ ok: true });
    await selecting;
    expect(mocks.leave).not.toHaveBeenCalled();
    expect(mocks.change).not.toHaveBeenCalled();
  });
});
