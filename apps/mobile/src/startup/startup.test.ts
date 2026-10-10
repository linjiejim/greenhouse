/**
 * Exercise the real root, splash, mark and readiness hooks. Native hosts are
 * replaced with DOM nodes and a cancellable animation clock; startup logic is
 * not mocked. The mobile app is outside the workspace, so use the web app's
 * matching React/ReactDOM pair and never require a separate mobile install.
 * Keep Node transform mode with a manually created happy-dom window: browser
 * import analysis otherwise insists the mocked native packages are installed.
 * Keep this as .test.ts: the isolated mobile typecheck excludes root unit tests.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const test = await vi.hoisted(async () => {
  const { Window } = await import('happy-dom');
  const window = new Window();
  for (const [name, value] of Object.entries({ window, document: window.document, navigator: window.navigator })) {
    vi.stubGlobal(name, value);
  }
  const { createRequire } = await import('node:module');
  const { resolve } = await import('node:path');
  const require = createRequire(resolve('apps/web/package.json'));
  const React = require('react') as typeof import('react');
  return {
    React,
    window,
    jsx: require('react/jsx-runtime'),
    jsxDev: require('react/jsx-dev-runtime'),
    createRoot: require('react-dom/client').createRoot as typeof import('react-dom/client').createRoot,
    Focus: React.createContext(true),
    timing: vi.fn(),
    reduced: vi.fn(),
    removeMotionListener: vi.fn(),
    motionListener: null as ((reduced: boolean) => void) | null,
    auth: { loading: true, user: { id: 'member-a' } as { id: string } | null, bootstrap: vi.fn(), logout: vi.fn() },
    prefs: { hydrate: vi.fn() },
    station: { activeId: 'station-a' },
    fonts: [false, null] as [boolean, Error | null],
    segments: ['(drawer)', '(main)'] as string[],
    router: { canDismiss: vi.fn(() => false), dismissAll: vi.fn(), replace: vi.fn() },
    renderRoute: (() => null) as () => ReturnType<typeof React.createElement> | null,
  };
});

vi.mock('react', () => ({ ...test.React, default: test.React }));
vi.mock('react/jsx-runtime', () => test.jsx);
vi.mock('react/jsx-dev-runtime', () => test.jsxDev);
vi.mock('react-native', () => {
  const View = ({ children, pointerEvents, accessibilityLabel }: any) =>
    test.React.createElement(
      'div',
      {
        'data-splash': pointerEvents === 'auto' ? 'true' : undefined,
        'aria-label': accessibilityLabel,
      },
      children,
    );
  class Value {
    value: number;
    stops = new Set<() => void>();
    constructor(value: number) {
      this.value = value;
    }
    setValue(value: number) {
      this.value = value;
    }
    interpolate({ outputRange }: { outputRange: number[] }) {
      return outputRange.at(-1);
    }
    stopAnimation() {
      for (const stop of [...this.stops]) stop();
    }
  }
  test.timing.mockImplementation((value: Value, options: { toValue: number; duration: number; delay?: number }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let callback: ((result: { finished: boolean }) => void) | undefined;
    const stop = () => {
      clearTimeout(timer);
      value.stops.delete(stop);
      const current = callback;
      callback = undefined;
      current?.({ finished: false });
    };
    return {
      start: (done: (result: { finished: boolean }) => void) => {
        callback = done;
        value.stops.add(stop);
        timer = setTimeout(
          () => {
            value.stops.delete(stop);
            value.setValue(options.toValue);
            callback = undefined;
            done({ finished: true });
          },
          options.duration + (options.delay ?? 0),
        );
      },
      stop,
    };
  });
  return {
    View,
    Text: ({ children }: any) => test.React.createElement('span', null, children),
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
    Animated: { Value, View, timing: test.timing },
    AccessibilityInfo: {
      isReduceMotionEnabled: test.reduced,
      addEventListener: (_name: string, listener: (reduced: boolean) => void) => {
        test.motionListener = listener;
        return { remove: test.removeMotionListener };
      },
    },
  };
});
vi.mock('react-native-svg', () => ({
  default: ({ children }: any) => test.React.createElement('svg', null, children),
  Path: ({ d, fill }: any) => test.React.createElement('path', { d, fill }),
}));
vi.mock('expo-font', () => ({ useFonts: () => test.fonts }));
vi.mock('expo-router', () => ({
  Stack: Object.assign(() => test.renderRoute(), { Screen: () => null }),
  useRouter: () => test.router,
  useSegments: () => test.segments,
  useIsFocused: () => test.React.useContext(test.Focus),
}));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: ({ children }: any) => children }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardProvider: ({ children }: any) => children }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: ({ children }: any) => children }));
vi.mock('../theme', () => ({
  useApplyAppearance: () => {},
  useTheme: () => ({ colors: { background: 'white', label: 'black' }, hex: { accent: 'green' } }),
  typo: { title2: {} },
}));
vi.mock('../store/auth', () => ({ useAuth: (selector: (state: typeof test.auth) => unknown) => selector(test.auth) }));
vi.mock('../store/prefs', () => ({
  usePrefs: (selector: (state: typeof test.prefs) => unknown) => selector(test.prefs),
}));
vi.mock('../store/stations', () => ({
  useStations: (selector: (state: typeof test.station) => unknown) => selector(test.station),
}));
vi.mock('../api/client', () => ({ setOnUnauthorized: vi.fn() }));
vi.mock('../widget/snapshot', () => ({ useWidgetSnapshot: () => {} }));
vi.mock('../settings/account-language', () => ({ useAccountLanguage: () => {} }));
vi.mock('../widget/art-host', () => ({ WidgetArtHost: () => null }));
vi.mock('../ui/dialogs', () => ({ DialogHost: () => null }));
vi.mock('../ui/menu', () => ({ MenuHost: () => null }));
vi.mock('../ui/toast', () => ({ ToastHost: () => null }));
vi.mock('../lib/i18n', () => ({ useT: () => (key: string) => key }));
vi.mock('../realtime/realtime-bridge', () => ({ RealtimeBridge: () => null }));
vi.mock('../ui/nav', () => ({
  detailScreen: () => ({}),
  modalScreen: () => ({}),
  pageScreen: () => ({}),
  sheetScreen: () => ({}),
  stackDefaults: () => ({}),
}));
vi.mock('../ui/sheet-edge', () => ({ sheetEdgeLayout: () => null }));

import RootLayout from '../../app/_layout';
import { Splash } from '../ui/splash';
import { GreenhouseMark, MARK_BUILD_MS } from '../ui/logo';
import { StartupContent, STARTUP_CONTENT_GRACE_MS } from './content';
import { StartupContext, useStartupContent, useStartupCovered } from './context';

const { act, createElement: h } = test.React;
let root: ReturnType<typeof test.createRoot> | null = null;
let container: HTMLDivElement;
const FADE_TOTAL_MS = 350;

async function render(element: ReturnType<typeof h>) {
  await act(async () => {
    root!.render(element);
  });
}
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}
function covered() {
  return !!container.querySelector('[data-splash]');
}
function fadeCalls() {
  return test.timing.mock.calls.filter(([, options]) => options.toValue === 0);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** The rendered destination starts its own one-shot request underneath the cover. */
function routeFixture() {
  const response = deferred<string>();
  const fetchContent = vi.fn(() => response.promise);
  const mount = vi.fn();
  const unmount = vi.fn();
  function Screen() {
    const [state, setState] = test.React.useState('loading');
    useStartupContent(state !== 'loading');
    const isCovered = useStartupCovered();
    test.React.useEffect(() => {
      mount();
      let alive = true;
      void fetchContent().then(
        (result) => {
          if (alive) setState(result);
        },
        () => {
          if (alive) setState('error');
        },
      );
      return () => {
        alive = false;
        unmount();
      };
    }, []);
    return h('article', { 'data-covered': String(isCovered) }, state);
  }
  test.renderRoute = () => h(Screen);
  return { response, fetchContent, mount, unmount };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  test.timing.mockClear();
  test.reduced.mockReset().mockResolvedValue(false);
  test.removeMotionListener.mockClear();
  test.motionListener = null;
  test.auth.loading = true;
  test.auth.user = { id: 'member-a' };
  test.auth.bootstrap.mockClear();
  test.prefs.hydrate.mockClear();
  test.station.activeId = 'station-a';
  test.fonts = [false, null];
  test.segments = ['(drawer)', '(main)'];
  test.router.canDismiss.mockReset().mockReturnValue(false);
  test.router.dismissAll.mockClear();
  test.router.replace.mockClear();
  test.renderRoute = () => null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = test.createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
});

afterAll(async () => {
  await test.window.happyDOM.close();
  vi.unstubAllGlobals();
});

describe('root startup reveal', () => {
  it('starts real content after auth, before fonts, and preserves the same screen across reveal', async () => {
    const screen = routeFixture();
    await render(h(RootLayout));
    await advance(MARK_BUILD_MS + STARTUP_CONTENT_GRACE_MS + FADE_TOTAL_MS);
    expect(screen.fetchContent).not.toHaveBeenCalled();
    expect(covered()).toBe(true);
    expect(fadeCalls()).toHaveLength(0);

    test.auth.loading = false;
    await render(h(RootLayout));
    const mountedNode = container.querySelector('article');
    expect(mountedNode?.textContent).toBe('loading');
    expect(mountedNode?.getAttribute('data-covered')).toBe('true');
    expect(screen.fetchContent).toHaveBeenCalledTimes(1);
    await act(async () => {
      screen.response.resolve('ready content');
    });
    await advance(10_000);
    expect(covered()).toBe(true);
    expect(fadeCalls()).toHaveLength(0);

    test.fonts = [true, null];
    await render(h(RootLayout));
    await advance(FADE_TOTAL_MS - 1);
    expect(covered()).toBe(true);
    await advance(1);
    expect(covered()).toBe(false);
    expect(container.querySelector('article')).toBe(mountedNode);
    expect(mountedNode?.textContent).toBe('ready content');
    expect(mountedNode?.getAttribute('data-covered')).toBe('false');
    expect(screen.mount).toHaveBeenCalledTimes(1);
    expect(screen.unmount).not.toHaveBeenCalled();
    expect(screen.fetchContent).toHaveBeenCalledTimes(1);
  });

  it.each(['populated', 'empty', 'error'])('fast %s content never cuts the mark build short', async (outcome) => {
    const screen = routeFixture();
    test.auth.loading = false;
    test.fonts = [true, null];
    await render(h(RootLayout));
    await act(async () => {
      if (outcome === 'error') screen.response.reject(new Error('offline'));
      else screen.response.resolve(outcome);
    });
    await advance(MARK_BUILD_MS - 1);
    expect(fadeCalls()).toHaveLength(0);
    expect(covered()).toBe(true);
    await advance(1);
    expect(fadeCalls()).toHaveLength(1);
    await advance(FADE_TOTAL_MS);
    expect(covered()).toBe(false);
    expect(container.querySelector('article')?.textContent).toBe(outcome);
  });

  it('waits briefly for slow content instead of revealing a second loading screen', async () => {
    const screen = routeFixture();
    test.auth.loading = false;
    test.fonts = [true, null];
    await render(h(RootLayout));
    await advance(MARK_BUILD_MS);
    await advance(STARTUP_CONTENT_GRACE_MS - 1);
    expect(fadeCalls()).toHaveLength(0);
    expect(covered()).toBe(true);
    await act(async () => {
      screen.response.resolve('ready content');
    });
    expect(fadeCalls()).toHaveLength(1);
    await advance(FADE_TOTAL_MS);
    expect(covered()).toBe(false);
    expect(container.querySelector('article')?.textContent).toBe('ready content');
  });

  it('reveals recoverable loading when content never settles, then accepts its eventual result', async () => {
    const screen = routeFixture();
    test.auth.loading = false;
    test.fonts = [true, null];
    await render(h(RootLayout));
    const mountedNode = container.querySelector('article');
    await advance(MARK_BUILD_MS);
    await advance(STARTUP_CONTENT_GRACE_MS - 1);
    expect(fadeCalls()).toHaveLength(0);
    await advance(1);
    expect(fadeCalls()).toHaveLength(1);
    await advance(FADE_TOTAL_MS);
    expect(covered()).toBe(false);
    expect(mountedNode?.textContent).toBe('loading');
    await act(async () => {
      screen.response.resolve('eventual result');
    });
    expect(container.querySelector('article')).toBe(mountedNode);
    expect(mountedNode?.textContent).toBe('eventual result');
    expect(screen.fetchContent).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a font failure settles the font gate instead of deadlocking startup', async () => {
    test.auth.loading = false;
    test.fonts = [false, new Error('font unavailable')];
    test.auth.user = null;
    test.segments = ['login'];
    await render(h(RootLayout));
    await advance(MARK_BUILD_MS);
    await advance(FADE_TOTAL_MS);
    expect(covered()).toBe(false);
  });

  it.each([
    ['knowledge', '[slug]'],
    ['settings', 'bots'],
    ['bots', 'request'],
  ])('a deep-linked %s page does not wait for the hidden home underneath', async (...segments) => {
    test.auth.loading = false;
    test.fonts = [true, null];
    test.segments = segments;
    await render(h(RootLayout));
    await advance(MARK_BUILD_MS);
    expect(fadeCalls()).toHaveLength(1);
    await advance(FADE_TOTAL_MS);
    expect(covered()).toBe(false);
  });

  it.each([['bots'], ['chat', '[id]']])(
    'a %s forwarder waits for the destination to report readiness',
    async (...segments) => {
      test.auth.loading = false;
      test.fonts = [true, null];
      test.segments = segments;
      await render(h(RootLayout));
      await advance(MARK_BUILD_MS);
      expect(fadeCalls()).toHaveLength(0);
      test.segments = ['(drawer)', '(main)'];
      const screen = routeFixture();
      await render(h(RootLayout));
      await act(async () => {
        screen.response.resolve('deep-linked thread');
      });
      await advance(FADE_TOTAL_MS);
      expect(covered()).toBe(false);
      expect(container.querySelector('article')?.textContent).toBe('deep-linked thread');
    },
  );
});

describe('splash deadline and animation lifecycle', () => {
  it('starts grace only after both app prerequisites and the mark settle', async () => {
    const onGone = vi.fn();
    await render(h(Splash, { ready: false, contentReady: false, onGone }));
    await advance(MARK_BUILD_MS);
    await advance(10_000);
    expect(fadeCalls()).toHaveLength(0);
    await render(h(Splash, { ready: true, contentReady: false, onGone }));
    await advance(STARTUP_CONTENT_GRACE_MS - 1);
    expect(fadeCalls()).toHaveLength(0);
    await advance(1);
    await advance(FADE_TOTAL_MS);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('clears and resets the deadline when auth or fonts become pending again', async () => {
    test.reduced.mockResolvedValue(true);
    const onGone = vi.fn();
    await render(h(Splash, { ready: true, contentReady: false, onGone }));
    await advance(STARTUP_CONTENT_GRACE_MS - 100);
    await render(h(Splash, { ready: false, contentReady: false, onGone }));
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    await render(h(Splash, { ready: true, contentReady: false, onGone }));
    await advance(STARTUP_CONTENT_GRACE_MS - 1);
    expect(fadeCalls()).toHaveLength(0);
    await advance(1);
    await advance(FADE_TOTAL_MS);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('content churn can cancel a fade but cannot extend the original deadline', async () => {
    test.reduced.mockResolvedValue(true);
    const onGone = vi.fn();
    await render(h(Splash, { ready: true, contentReady: false, onGone }));
    await advance(1000);
    await render(h(Splash, { ready: true, contentReady: true, onGone }));
    await advance(100);
    await render(h(Splash, { ready: true, contentReady: false, onGone }));
    await advance(399);
    expect(onGone).not.toHaveBeenCalled();
    expect(fadeCalls()).toHaveLength(1);
    await advance(1);
    expect(fadeCalls()).toHaveLength(2);
    await advance(FADE_TOTAL_MS);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it.each(['grace', 'fade'])('unmounting during %s cancels callbacks and timers', async (phase) => {
    test.reduced.mockResolvedValue(true);
    const onGone = vi.fn();
    await render(h(Splash, { ready: true, contentReady: phase === 'fade', onGone }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await render(h('div'));
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    expect(onGone).not.toHaveBeenCalled();
    expect(test.removeMotionListener).toHaveBeenCalledTimes(1);
  });

  it('a finished fade uses the latest callback without restarting the animation', async () => {
    test.reduced.mockResolvedValue(true);
    const before = vi.fn();
    const after = vi.fn();
    await render(h(Splash, { ready: true, contentReady: true, onGone: before }));
    await advance(100);
    await render(h(Splash, { ready: true, contentReady: true, onGone: after }));
    await advance(FADE_TOTAL_MS - 100);
    expect(fadeCalls()).toHaveLength(1);
    expect(before).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe('focused content ownership', () => {
  function Probe({ ready, label }: { ready: boolean; label: string }) {
    useStartupContent(ready);
    return h('span', { 'data-probe': label }, String(useStartupCovered()));
  }
  function probe(content: StartupContent, ready: boolean, focused: boolean, isCovered = true) {
    return h(
      StartupContext.Provider,
      { value: { content, covered: isCovered } },
      h(test.Focus.Provider, { value: focused }, h(Probe, { ready, label: 'screen' })),
    );
  }

  it('ignores underlying ready home and reports only a focused screen', async () => {
    const content = new StartupContent();
    await render(probe(content, true, false));
    expect(content.getSnapshot()).toBe(false);
    await render(probe(content, true, true));
    expect(content.getSnapshot()).toBe(true);
    await render(probe(content, true, false));
    expect(content.getSnapshot()).toBe(false);
  });

  it('releases the forwarder to a pending thread without inheriting old readiness', async () => {
    const content = new StartupContent();
    const screens = (thread: boolean, ready: boolean) =>
      h(
        StartupContext.Provider,
        { value: { content, covered: true } },
        h(test.Focus.Provider, { value: !thread }, h(Probe, { ready: true, label: 'home' })),
        h(test.Focus.Provider, { value: thread }, h(Probe, { ready, label: 'thread' })),
      );
    await render(screens(false, false));
    expect(content.getSnapshot()).toBe(true);
    await render(screens(true, false));
    expect(content.getSnapshot()).toBe(false);
    await render(screens(true, true));
    expect(content.getSnapshot()).toBe(true);
  });

  it('a new account or station gets a fresh coordinator and clears the old owner', async () => {
    const first = new StartupContent();
    const second = new StartupContent();
    await render(probe(first, true, true));
    expect(first.getSnapshot()).toBe(true);
    await render(probe(second, false, true));
    expect(first.getSnapshot()).toBe(false);
    expect(second.getSnapshot()).toBe(false);
    await render(probe(second, true, true));
    expect(second.getSnapshot()).toBe(true);
  });

  it('stops reporting after reveal and treats an absent provider as uncovered', async () => {
    const content = new StartupContent();
    await render(probe(content, true, true));
    expect(content.getSnapshot()).toBe(true);
    expect(container.textContent).toBe('true');
    await render(probe(content, true, true, false));
    expect(content.getSnapshot()).toBe(false);
    expect(container.textContent).toBe('false');
    await render(h(Probe, { ready: true, label: 'standalone' }));
    expect(container.textContent).toBe('false');
  });
});

describe('reduced-motion mark readiness', () => {
  it('reports built immediately when Reduce Motion is enabled', async () => {
    test.reduced.mockResolvedValue(true);
    const onBuilt = vi.fn();
    await render(h(GreenhouseMark, { animate: true, onBuilt }));
    expect(onBuilt).toHaveBeenCalledTimes(1);
    expect(test.timing).not.toHaveBeenCalled();
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reveals fast reduced-motion startup without waiting through the build or grace', async () => {
    test.reduced.mockResolvedValue(true);
    const onGone = vi.fn();
    await render(h(Splash, { ready: true, contentReady: true, onGone }));
    expect(fadeCalls()).toHaveLength(1);
    await advance(FADE_TOTAL_MS);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('finishes safely if Reduce Motion turns on during the animation', async () => {
    const onBuilt = vi.fn();
    await render(h(GreenhouseMark, { animate: true, onBuilt }));
    await advance(100);
    expect(onBuilt).not.toHaveBeenCalled();
    await act(async () => {
      test.motionListener?.(true);
    });
    expect(onBuilt).toHaveBeenCalledTimes(1);
    await advance(MARK_BUILD_MS);
    expect(onBuilt).toHaveBeenCalledTimes(1);
  });

  it('falls back to a complete static mark if the accessibility lookup fails', async () => {
    test.reduced.mockRejectedValue(new Error('native lookup failed'));
    const onBuilt = vi.fn();
    await render(h(GreenhouseMark, { animate: true, onBuilt }));
    expect(onBuilt).toHaveBeenCalledTimes(1);
    expect(test.timing).not.toHaveBeenCalled();
  });

  it('ignores a delayed accessibility result after the mark unmounts', async () => {
    const answer = deferred<boolean>();
    test.reduced.mockReturnValue(answer.promise);
    const onBuilt = vi.fn();
    await render(h(GreenhouseMark, { animate: true, onBuilt }));
    await render(h('div'));
    await act(async () => {
      answer.resolve(true);
    });
    expect(onBuilt).not.toHaveBeenCalled();
    expect(test.timing).not.toHaveBeenCalled();
    expect(test.removeMotionListener).toHaveBeenCalledTimes(1);
  });
});
