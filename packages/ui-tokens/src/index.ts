/** Minimal browser bridge for installed, trusted plugin frontends. */
import { EMBED_PROTOCOL, type EmbedInitMessage } from '@greenhouse/types/plugins';
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
    }
  };
  window.addEventListener('message', receive);
  send(EMBED_PROTOCOL.ready);
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
    disconnect() {
      window.removeEventListener('message', receive);
      clearTimeout(timer);
      rejectRefresh?.(new Error('Bridge disconnected'));
      resolveRefresh = rejectRefresh = null;
      pending = null;
      state = null;
    },
  };
}
