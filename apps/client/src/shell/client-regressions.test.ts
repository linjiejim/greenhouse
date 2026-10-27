/** Browser regressions without launching Chromium. Native hosts are replaced at the outer edge. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const harness = await vi.hoisted(async () => {
  const { Window } = await import('happy-dom');
  const window = new Window({ width: 1440, height: 900 });
  for (const [name, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    innerWidth: 1440,
    innerHeight: 900,
  }))
    vi.stubGlobal(name, value);
  const { createRequire } = await import('node:module');
  const { resolve } = await import('node:path');
  const req = createRequire(resolve('package.json'));
  const React = req('react') as typeof import('react');
  return {
    React,
    jsx: req('react/jsx-runtime'),
    jsxDev: req('react/jsx-dev-runtime'),
    createRoot: req('react-dom/client').createRoot as typeof import('react-dom/client').createRoot,
    window,
    width: 1440,
    mounts: 0,
    router: { navigate: vi.fn(), push: vi.fn() },
    user: { id: 'member', nickname: 'Jim', role: 'team' },
    hex: { background: 'white', label: 'black', accent: 'green', separator: 'gray' },
  };
});
vi.mock('react', () => ({ ...harness.React, default: harness.React }));
vi.mock('react/jsx-runtime', () => harness.jsx);
vi.mock('react/jsx-dev-runtime', () => harness.jsxDev);
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  StyleSheet: { create: (x: unknown) => x },
  useWindowDimensions: () => ({ width: harness.width, height: 900 }),
  View: ({ children, testID }: any) => harness.React.createElement('div', { 'data-testid': testID }, children),
  Text: ({ children }: any) => harness.React.createElement('span', null, children),
  ScrollView: ({ children }: any) => harness.React.createElement('div', null, children),
  Pressable: ({ children, onPress, accessibilityLabel, testID }: any) =>
    harness.React.createElement(
      'button',
      {
        'aria-label': accessibilityLabel,
        'data-testid': testID,
        onClick: (e: any) => {
          e.stopPropagation();
          onPress?.();
        },
      },
      children,
    ),
}));
vi.mock('expo-router', () => ({
  useRouter: () => harness.router,
  usePathname: () => '/chat',
  useGlobalSearchParams: () => ({ session: 'conversation' }),
}));
vi.mock('../theme', () => ({
  useTheme: () => ({ hex: harness.hex, colors: harness.hex }),
  space: { md: 12, lg: 16, sm: 8, xs: 4 },
  typo: { caption1: {}, title2: {}, footnote: {}, body: {} },
}));
vi.mock('../store/auth', () => ({ useAuth: (s: any) => s({ user: harness.user }) }));
vi.mock('../store/stations', () => ({ getApiBase: () => 'https://example.test' }));
vi.mock('../store/prefs', () => ({ usePrefs: (s: any) => s({ lang: 'zh' }) }));
vi.mock('../store/notifications', () => ({
  useNotifications: Object.assign((s: any) => s({ unread: 0 }), { getState: () => ({ refresh: vi.fn() }) }),
}));
vi.mock('../store/sessions', () => ({
  useSessions: Object.assign((s: any) => s({ items: [], status: 'ready' }), { getState: () => ({ refresh: vi.fn() }) }),
}));
vi.mock('../plugins/store', () => ({ useStationManifest: (s: any) => s({ data: { kind: 'legacy' } }) }));
vi.mock('../lib/i18n', () => ({ useT: () => (s: string) => s }));
vi.mock('../ui/logo', () => ({ GreenhouseMark: () => null }));
vi.mock('../ui/core', () => ({ Icon: () => null }));
vi.mock('../ui/core.web', () => ({ Icon: () => null }));
vi.mock('../ui/use-shortcut', async () => import('../ui/use-shortcut.web'));
vi.mock('../ui/sidebar', () => ({ usePersistentSidebar: () => harness.width >= 760 }));
vi.mock('./sidebar-content', () => ({ SidebarContent: () => null }));
vi.mock('expo-router/drawer', () => ({
  Drawer: Object.assign(() => harness.React.createElement('input', { defaultValue: 'route:policy-chat' }), {
    Screen: () => null,
  }),
}));
vi.mock('../ui/menu', () => ({ NativeMenu: ({ children }: any) => children }));
vi.mock('../ui/segmented', () => ({ Segmented: () => null }));
vi.mock('../ui/dialogs', () => ({ promptText: vi.fn() }));
vi.mock('../chat/conversation-row.web', () => ({ ConversationRow: () => null }));
vi.mock('../api/profiles', () => ({ listProfiles: async () => ({ ok: true, data: [] }), profileName: () => '' }));
vi.mock('../api/assistant', () => ({ listAutomationRuns: async () => ({ ok: true, data: { sessions: [] } }) }));
vi.mock('../api/shares', () => ({ listShares: async () => ({ ok: true, data: [] }), markShareRead: vi.fn() }));
vi.mock('../data/identity', () => ({ captureIdentity: () => () => true }));
vi.mock('./desktop-tools.web', () => ({
  AccountMenu: () => null,
  NotificationsPopover: () => null,
  SearchPalette: () => null,
}));
import DrawerLayout from '../../app/(drawer)/_layout.web';
import { GreenhouseMark as WebMark } from '../ui/logo.web';
import { WideShell } from './wide-shell.web';
import { NativeMenu } from '../ui/menu.web';
import { Splash } from '../ui/splash.web';
import { STARTUP_CONTENT_GRACE_MS } from '../startup/content';
const { createElement: h, act } = harness.React;
let host: HTMLDivElement, root: ReturnType<typeof harness.createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.width = 1440;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  host = document.createElement('div');
  document.body.append(host);
  root = harness.createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});
it('keeps a conversation and its local draft through 1440 → 390 → 1440', async () => {
  function Conversation() {
    const [draft, setDraft] = harness.React.useState('');
    return h('button', { onClick: () => setDraft('unsent draft'), 'data-testid': 'draft' }, draft || 'conversation');
  }
  const render = () => root.render(h(WideShell, null, h(Conversation)));
  await act(async () => render());
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid=draft]')!.click());
  const main = host.querySelector('[data-testid=client-main]');
  for (const width of [390, 1440]) {
    harness.width = width;
    await act(async () => render());
    expect(host.querySelector('[data-testid=client-main]')).toBe(main);
    expect(host.textContent).toContain('unsent draft');
  }
});
it('toggles the secondary immediately after crossing the compact breakpoint', async () => {
  const render = () => root.render(h(WideShell, null, h('span', null, 'conversation')));
  await act(async () => render());
  harness.width = 1024;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  await act(async () => render());
  expect(host.querySelector('[data-testid=client-secondary]')).toBeNull();
  const toggle = () => window.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: '\\', metaKey: true }));
  await act(async () => {
    toggle();
  });
  expect(host.querySelector('[data-testid=client-secondary]')).not.toBeNull();
  await act(async () => {
    toggle();
  });
  expect(host.querySelector('[data-testid=client-secondary]')).toBeNull();
});
it('opens a menu above a Pressable that stops click bubbling, and selects once', async () => {
  const selected = vi.fn();
  await act(async () =>
    root.render(
      h(
        NativeMenu,
        { items: [{ id: 'crm', title: '客户' }], onSelect: selected },
        h('button', { onClick: (e: any) => e.stopPropagation() }, '更多'),
      ),
    ),
  );
  await act(async () => host.querySelector('button')!.click());
  const item = document.querySelector<HTMLButtonElement>('[role=menuitem]');
  expect(item?.textContent).toContain('客户');
  await act(async () => item!.click());
  expect(selected).toHaveBeenCalledExactlyOnceWith('crm');
  expect(document.querySelector('[role=menu]')).toBeNull();
});
it('removes the web startup cover after content is ready or its grace expires', async () => {
  vi.useFakeTimers();
  const gone = vi.fn();
  await act(async () => root.render(h(Splash, { ready: true, contentReady: false, onGone: gone })));
  await act(async () => {
    vi.advanceTimersByTime(STARTUP_CONTENT_GRACE_MS);
  });
  await act(async () => {
    vi.advanceTimersByTime(160);
  });
  expect(gone).toHaveBeenCalledOnce();
});

it('keeps the actual drawer navigator subtree mounted at every breakpoint', async () => {
  await act(async () => root.render(h(DrawerLayout)));
  const input = host.querySelector('input')!;
  input.value = 'route:policy-chat?draft=hello';
  for (const width of [390, 1024, 1440]) {
    harness.width = width;
    await act(async () => root.render(h(DrawerLayout)));
    expect(host.querySelector('input')).toBe(input);
    expect(input.value).toContain('draft=hello');
  }
});
it('renders Haven SVG with valid DOM attributes and no React warning', async () => {
  const errors = vi.spyOn(console, 'error');
  await act(async () => root.render(h(WebMark)));
  expect(host.querySelector('svg')?.getAttribute('accessible')).toBeNull();
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});
it('selects keyboard menu items without reopening their portal', async () => {
  const selected = vi.fn();
  await act(async () =>
    root.render(
      h(NativeMenu, { items: [{ id: 'crm', title: '客户' }], onSelect: selected }, h('button', null, '更多')),
    ),
  );
  await act(async () => host.querySelector('button')!.click());
  const item = document.querySelector<HTMLButtonElement>('[role=menuitem]')!;
  await act(async () => {
    item.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    item.click();
  });
  expect(selected).toHaveBeenCalledExactlyOnceWith('crm');
  expect(document.querySelector('[role=menu]')).toBeNull();
});

it('handles the first sidebar shortcut even before RN receives the resize', async () => {
  const render = () => root.render(h(WideShell, null, h('span', null, 'conversation')));
  await act(async () => render());
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  await act(async () => {
    window.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: '\\', metaKey: true }));
  });
  harness.width = 1024;
  await act(async () => render());
  expect(host.querySelector('[data-testid=client-secondary]')).not.toBeNull();
});
