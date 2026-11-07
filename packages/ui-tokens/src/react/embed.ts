/**
 * One call wires a plugin page to its host: the bridge, a status the page can render (connecting,
 * ready, failed), authenticated fetch with one renewal, the host title and title-bar actions, and
 * confirms and notices the host draws over the whole app (apps/client/DESIGN.md Embeds).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { EmbedInitMessage } from '@greenhouse/types/plugins';
import { connectGreenhouse } from '../index.js';
import { escapeTopLayer, hasLayer, subscribeLayers } from './layers.js';

export type EmbedStatus = 'connecting' | 'ready' | 'failed';
export interface EmbedState {
  status: EmbedStatus;
  locale: 'en' | 'zh';
  user: EmbedInitMessage['user'] | null;
}

type Bridge = ReturnType<typeof connectGreenhouse>;
let current: { bridge: Bridge; baseTitle: () => string } | null = null;

// One embed per page: its state is module-wide so every kit component can read the locale.
let state: EmbedState = { status: 'connecting', locale: 'zh', user: null };
const listeners = new Set<() => void>();
const setState = (next: Partial<EmbedState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The page's connection status, locale and member. */
export function useEmbed(): EmbedState {
  return useSyncExternalStore(subscribe, () => state);
}

function host(): Bridge {
  if (!current) throw new Error('createEmbed() has not run');
  return current.bridge;
}

/** Desktop is an installed, trusted host that names itself; nothing else may. */
function hostOrigin(): string {
  const hinted = new URLSearchParams(window.location.search).get('host_origin');
  return hinted === 'tauri://localhost' ? hinted : window.location.origin;
}

export function createEmbed(
  options: {
    /** The page's own title in the host bar, restored when an object view closes. */
    title?: (locale: 'en' | 'zh') => string;
    onInit?: (message: EmbedInitMessage) => void;
  } = {},
) {
  setState({ locale: new URLSearchParams(window.location.search).get('locale') === 'en' ? 'en' : 'zh' });
  const bridge = connectGreenhouse({
    hostOrigin: hostOrigin(),
    onInit(message) {
      setState({ status: 'ready', locale: message.locale === 'en' ? 'en' : 'zh', user: message.user });
      options.onInit?.(message);
    },
    onTimeout: () => setState({ status: 'failed' }),
  });
  current = { bridge, baseTitle: () => options.title?.(state.locale) ?? '' };
  startTrail();
  unsubscribeLayers?.();
  unsubscribeLayers = subscribeLayers(syncBack);
  return {
    bridge,
    useEmbed,
    getState: () => state,
    /** fetch() with the embed token; one transparent renewal through the host on 401. */
    async embedFetch(input: string, init: RequestInit = {}): Promise<Response> {
      const send = (token: string) => {
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${token}`);
        return fetch(input, { ...init, headers });
      };
      const response = await send(bridge.token);
      if (response.status !== 401) return response;
      return send(await bridge.refresh());
    },
    /** A failed connection retries by loading the page again. */
    retry: () => window.location.reload(),
  };
}

/** Ask the host for a confirm (title as a question, the button repeating its verb). */
export function confirm(request: {
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}): Promise<boolean> {
  return host().confirm(request);
}

/** Notices drawn by the host: see EmbedNotifyRequest for how long each kind stays. */
export const notify = {
  success: (text: string) => void host().notify({ kind: 'success', text }),
  info: (text: string) => void host().notify({ kind: 'info', text }),
  warning: (text: string) => void host().notify({ kind: 'warning', text }),
  /** The action already ran; `onUndo` runs if the member presses Undo within 8 s. */
  undo: (text: string, onUndo: () => void) =>
    void host()
      .notify({ kind: 'undo', text, actionLabel: 'undo' })
      .then((answer) => answer === 'action' && onUndo()),
  /** Stays until dismissed; `retry` adds a Retry action. */
  error: (text: string, retry?: { label: string; onRetry: () => void }) =>
    void host()
      .notify({ kind: 'error', text, actionLabel: retry?.label })
      .then((answer) => answer === 'action' && retry?.onRetry()),
};

/** While mounted, the host bar shows `title`; the page title comes back on unmount. */
export function useHostTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title || !current) return;
    const embed = current;
    embed.bridge.title(title);
    return () => embed.bridge.title(embed.baseTitle());
  }, [title]);
}

/** Icon actions in the host's title bar while mounted (`icon` is a lucide name). */
export function useHeaderActions(
  actions: { id: string; label: string; icon: string; disabled?: boolean; onPress: () => void }[],
) {
  const latest = useRef(actions);
  latest.current = actions;
  const key = JSON.stringify(actions.map(({ onPress: _, ...a }) => a));
  useEffect(() => {
    if (!current) return;
    const embed = current;
    const visible = JSON.parse(key) as { id: string; label: string; icon: string; disabled?: boolean }[];
    embed.bridge.header(
      visible.map((a) => ({ ...a, onPress: () => latest.current.find((x) => x.id === a.id)?.onPress() })),
    );
    return () => embed.bridge.header([]);
  }, [key]);
}

// ─── Back ─────────────────────────────────────────────────

// The views this page has opened in its own hash history, oldest first, compared without their
// query (filters are written with replaceState and never fire hashchange).
let trail: string[] = [];
let replacing = false;
let tracking = false;
const viewOf = (hash: string) => (hash || '#/').split('?')[0];

function startTrail() {
  trail = [viewOf(window.location.hash)];
  if (tracking) return;
  tracking = true;
  window.addEventListener('hashchange', () => {
    const view = viewOf(window.location.hash);
    if (replacing) {
      replacing = false;
      trail = [view];
    } else if (trail.length > 1 && trail[trail.length - 2] === view) trail.pop();
    else if (trail[trail.length - 1] !== view) trail.push(view);
  });
}

/**
 * Leave the current sub-view: back to the view it was opened from when this page opened it, else
 * (a deep link, a reload) to `parent` (`#/…`) without leaving an entry to come back to.
 */
export function hashBack(parent: string) {
  if (trail.length > 1) {
    window.history.back();
    return;
  }
  const target = parent.startsWith('#') ? parent : `#${parent}`;
  if (viewOf(target) === viewOf(window.location.hash)) return;
  replacing = true;
  window.location.replace(target);
}

const backs: { run: () => void }[] = [];
let unsubscribeLayers: (() => void) | null = null;
// An open Dialog, Drawer or popup closes first (as Escape would), then the view's own Back runs.
function syncBack() {
  const top = backs[backs.length - 1];
  current?.bridge.back(hasLayer() ? escapeTopLayer : top ? () => top.run() : null);
}

/**
 * While mounted with a handler, the host's back control (header back, Android back, the wide
 * header's Back) runs it instead of closing the page. Open kit overlays close first; among views
 * the latest mounted handler wins, so register one per view. Pass null at the page's top view.
 */
export function useHostBack(handler: (() => void) | null | false | undefined) {
  const latest = useRef(handler);
  latest.current = handler;
  const on = Boolean(handler);
  useEffect(() => {
    if (!on || !current) return;
    const entry = { run: () => void (latest.current || undefined)?.() };
    backs.push(entry);
    syncBack();
    return () => {
      backs.splice(backs.indexOf(entry), 1);
      syncBack();
    };
  }, [on]);
}
