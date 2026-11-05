/** Minimal browser bridge for installed, trusted plugin frontends. */
import {
  EMBED_PROTOCOL,
  type EmbedConfirmRequest,
  type EmbedHeaderAction,
  type EmbedInitMessage,
  type EmbedNotifyRequest,
} from '@greenhouse/types/plugins';
import { themeTokens } from './tokens.generated.js';
export { tokenNames, themeTokens } from './tokens.generated.js';

/** The theme defaults with the host's `--gh-*` overrides on top. */
export function resolveThemeTokens(theme: 'light' | 'dark', tokens: Record<string, string>): Record<string, string> {
  return { ...themeTokens[theme], ...tokens };
}

export function connectGreenhouse(
  options: {
    /** Desktop frames must explicitly trust tauri://localhost. Browser default is same origin. */
    hostOrigin?: string;
    onInit?: (message: EmbedInitMessage) => void;
    onTheme?: (theme: 'light' | 'dark') => void;
    /** No init within `initTimeoutMs` (default 10 s): the host is missing or refused the page. */
    onTimeout?: () => void;
    initTimeoutMs?: number;
  } = {},
) {
  const origin = options.hostOrigin ?? window.location.origin;
  // Native WebView injects authenticated host messages with no browser sender;
  // its outgoing shim is installed before the plugin loads. Framed browser
  // pages must always retain the exact parent-window/origin check.
  const nativeHost =
    window.parent === window &&
    typeof (
      window as Window & {
        ReactNativeWebView?: { postMessage?: unknown };
      }
    ).ReactNativeWebView?.postMessage === 'function';
  let state: EmbedInitMessage | null = null;
  let pending: Promise<string> | null = null;
  let resolveRefresh: ((token: string) => void) | null = null;
  let rejectRefresh: ((error: Error) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  const confirms = new Map<string, (ok: boolean) => void>();
  const notices = new Map<string, (answer: 'action' | 'dismissed') => void>();
  let headerActions = new Map<string, () => void>();
  const nextId = () => `m${++sequence}-${Math.random().toString(36).slice(2, 8)}`;
  const send = (type: string, payload = {}) => window.parent.postMessage({ type, ...payload }, origin);
  const apply = (theme: 'light' | 'dark', tokens: Record<string, string>) => {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(resolveThemeTokens(theme, tokens))) {
      if (key.startsWith('--') && typeof value === 'string') root.style.setProperty(key, value);
    }
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    options.onTheme?.(theme);
  };
  const receive = (event: MessageEvent) => {
    if (
      nativeHost
        ? event.source !== null || event.origin !== ''
        : event.source !== window.parent || event.origin !== origin
    )
      return;
    const m = event.data;
    if (!m || typeof m !== 'object') return;
    if (
      m.type === EMBED_PROTOCOL.init &&
      (m.theme === 'light' || m.theme === 'dark') &&
      typeof m.token === 'string' &&
      m.user
    ) {
      state = m;
      clearTimeout(initTimer);
      document.documentElement.lang = m.locale;
      apply(m.theme, m.tokens ?? {});
      options.onInit?.(m);
    } else if (m.type === EMBED_PROTOCOL.theme && state && (m.theme === 'light' || m.theme === 'dark')) {
      state = { ...state, theme: m.theme, tokens: m.tokens };
      apply(m.theme, m.tokens ?? {});
    } else if (
      m.type === EMBED_PROTOCOL.token &&
      state &&
      typeof m.token === 'string' &&
      typeof m.expires_at === 'string'
    ) {
      state = { ...state, token: m.token, expires_at: m.expires_at };
      clearTimeout(timer);
      resolveRefresh?.(m.token);
      pending = null;
      resolveRefresh = rejectRefresh = null;
    } else if (m.type === EMBED_PROTOCOL.confirmResult && typeof m.id === 'string') {
      confirms.get(m.id)?.(m.ok === true);
      confirms.delete(m.id);
    } else if (
      (m.type === EMBED_PROTOCOL.notifyAction || m.type === EMBED_PROTOCOL.notifyDismissed) &&
      typeof m.id === 'string'
    ) {
      notices.get(m.id)?.(m.type === EMBED_PROTOCOL.notifyAction ? 'action' : 'dismissed');
      notices.delete(m.id);
    } else if (m.type === EMBED_PROTOCOL.headerAction && typeof m.id === 'string') {
      headerActions.get(m.id)?.();
    }
  };
  window.addEventListener('message', receive);
  // The host names its theme in the frame URL: paint in it now, not after the token round trip
  // behind init, or a dark host shows a light page first.
  const initial = new URLSearchParams(window.location.search).get('theme');
  if (initial === 'light' || initial === 'dark') apply(initial, {});
  send(EMBED_PROTOCOL.ready);
  const initTimer = setTimeout(() => {
    if (!state) options.onTimeout?.();
  }, options.initTimeoutMs ?? 10_000);
  return {
    get token() {
      return state?.token ?? '';
    },
    get context() {
      return state;
    },
    refresh(): Promise<string> {
      if (pending) return pending;
      pending = new Promise((resolve, reject) => {
        resolveRefresh = resolve;
        rejectRefresh = reject;
        timer = setTimeout(() => {
          pending = null;
          resolveRefresh = rejectRefresh = null;
          reject(new Error('Token refresh timed out'));
        }, 15_000);
      });
      send(EMBED_PROTOCOL.tokenRefresh);
      return pending;
    },
    navigate: (href: string) => send(EMBED_PROTOCOL.navigate, { href }),
    sendPrompt: (text: string) => send(EMBED_PROTOCOL.sendPrompt, { text }),
    title: (title: string) => send(EMBED_PROTOCOL.title, { title }),
    /** Keep the page's own view (`#/…`) in the host address, replacing the current entry. */
    route: (route: string) => send(EMBED_PROTOCOL.route, { route }),
    /** Ask the host to draw a confirm over the whole app; resolves with the member's answer. */
    confirm(request: Omit<EmbedConfirmRequest, 'id'>): Promise<boolean> {
      const id = nextId();
      return new Promise((resolve) => {
        confirms.set(id, resolve);
        send(EMBED_PROTOCOL.confirm, { ...request, id });
      });
    },
    /** Ask the host to show a notice; resolves `action` when its action is pressed. */
    notify(request: Omit<EmbedNotifyRequest, 'id'>): Promise<'action' | 'dismissed'> {
      const id = nextId();
      return new Promise((resolve) => {
        if (request.actionLabel) notices.set(id, resolve);
        else resolve('dismissed');
        send(EMBED_PROTOCOL.notify, { ...request, id });
      });
    },
    /** Put icon actions in the host's title bar (an empty list clears them). */
    header(actions: (EmbedHeaderAction & { onPress: () => void })[]) {
      headerActions = new Map(actions.map((a) => [a.id, a.onPress]));
      send(EMBED_PROTOCOL.header, { actions: actions.map(({ onPress: _, ...a }) => a) });
    },
    disconnect() {
      window.removeEventListener('message', receive);
      clearTimeout(timer);
      clearTimeout(initTimer);
      for (const resolve of confirms.values()) resolve(false);
      confirms.clear();
      notices.clear();
      headerActions.clear();
      rejectRefresh?.(new Error('Bridge disconnected'));
      resolveRefresh = rejectRefresh = null;
      pending = null;
      state = null;
    },
  };
}
