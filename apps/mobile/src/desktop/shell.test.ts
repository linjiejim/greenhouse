import { afterEach, expect, it, vi } from 'vitest';
const harness = await vi.hoisted(async () => {
  const { Window } = await import('happy-dom');
  const window = new Window();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    CustomEvent: window.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    vi.stubGlobal(key, value);
  const { createRequire } = await import('node:module');
  const { resolve } = await import('node:path');
  const req = createRequire(resolve('apps/web/package.json'));
  return {
    React: req('react'),
    jsx: req('react/jsx-runtime'),
    jsxDev: req('react/jsx-dev-runtime'),
    createRoot: req('react-dom/client').createRoot,
    router: { navigate: vi.fn(), replace: vi.fn() },
    invoke: vi.fn().mockResolvedValue([]),
    listeners: new Map<string, (event: { payload: unknown }) => void>(),
    shortcuts: new Map<string, () => void>(),
    t: (s: string) => s,
  };
});
vi.mock('react', () => ({ ...harness.React, default: harness.React }));
vi.mock('react/jsx-runtime', () => harness.jsx);
vi.mock('react/jsx-dev-runtime', () => harness.jsxDev);
vi.mock('expo-router', () => ({ useRouter: () => harness.router }));
vi.mock('../shell/wide-shell.web', () => ({
  WideShell: ({ children }: any) => harness.React.createElement('main', null, children),
}));
vi.mock('../store/auth', () => ({
  useAuth: Object.assign((s: any) => s({ user: null, loading: false }), {
    getState: () => ({ bootstrap: vi.fn() }),
    setState: vi.fn(),
  }),
}));
vi.mock('../store/stations', () => ({
  useStations: Object.assign((s: any) => s({ activeId: 'station' }), { getState: () => ({ activeId: 'station' }) }),
  getApiBase: () => 'https://station.test',
}));
vi.mock('../store/notifications', () => ({
  useNotifications: Object.assign((s: any) => s({ unread: 0 }), { getState: () => ({ refresh: vi.fn() }) }),
}));
vi.mock('../shell/inspector.web', () => ({ useInspector: { getState: () => ({ close: null }) } }));
vi.mock('../ui/overlay.web', () => ({ hasInteractiveOverlay: () => false }));
vi.mock('../ui/use-shortcut', () => ({
  useShortcut: (key: string, action: () => void) => harness.shortcuts.set(key, action),
}));
vi.mock('../data/identity', () => ({ captureIdentity: () => () => true }));
vi.mock('../api/token-storage', () => ({
  getAccessToken: () => null,
  onTokensChanged: () => () => {},
  hydrateTokens: vi.fn(),
  getCachedUser: () => null,
}));
vi.mock('../lib/i18n', () => ({ useT: () => harness.t }));
vi.mock('./quick-ask.web', () => ({
  QuickAsk: () => harness.React.createElement('textarea', { 'aria-label': 'Quick ask' }),
}));
import { ClientShell } from './client-shell.desktop';
let root: any;
afterEach(async () => {
  if (root) await harness.React.act(() => root.unmount());
  document.body.innerHTML = '';
  harness.listeners.clear();
  vi.clearAllMocks();
});
function native(label: string) {
  Object.assign(window, {
    __GREENHOUSE_WINDOW__: label,
    __TAURI__: {
      core: { invoke: harness.invoke },
      event: {
        listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
          harness.listeners.set(name, callback);
          return () => harness.listeners.delete(name);
        },
      },
    },
  });
}
it('keeps Expo navigation mounted but hidden in the composer-only Quick ask window', async () => {
  native('quick-ask');
  const h = harness.React.createElement;
  let mounts = 0;
  function Navigator() {
    harness.React.useEffect(() => {
      mounts++;
    }, []);
    return h('div', { 'data-testid': 'navigator' });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = harness.createRoot(host);
  await harness.React.act(async () => root.render(h(ClientShell, null, h(Navigator))));
  expect(mounts).toBe(1);
  expect(host.querySelector('[data-testid=navigator]')?.parentElement?.style.display).toBe('none');
  expect(host.querySelector('textarea')).not.toBeNull();
  expect(host.querySelector('main')).toBeNull();
  harness.shortcuts.get('Escape')!();
  expect(harness.invoke).toHaveBeenCalledWith('close_window', undefined);
});
it('delivers native menu shortcuts to the same useShortcut event channel', async () => {
  native('main');
  const host = document.createElement('div');
  document.body.append(host);
  root = harness.createRoot(host);
  await harness.React.act(async () =>
    root.render(harness.React.createElement(ClientShell, null, harness.React.createElement('div'))),
  );
  const received = vi.fn();
  window.addEventListener('greenhouse:shortcut', received, { once: true });
  harness.listeners.get('desktop:shortcut')!({ payload: 'mod+k' });
  expect(received.mock.calls[0][0].detail).toBe('mod+k');
});
