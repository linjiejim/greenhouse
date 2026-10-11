/**
 * The live screen's connection, owned by the app (the page in ./viewer-html.ts
 * only draws): mint a one-time view ticket with the member's bearer token, hand
 * the page the socket URL, and keep it honest —
 *
 * - every (re)connect mints a fresh ticket (60 s, single use), so a dropped
 *   socket never retries with a spent one;
 * - unexpected drops back off 1 s → 15 s, and after MAX_RETRIES the member
 *   gets "Reconnect" (the web's numbers: computer-screen.tsx, pinned by a
 *   tripwire in vendor.parity.test.ts);
 * - the app in the background drops the socket at once (iOS suspends the
 *   WebView anyway); back in front it reconnects. A member who held the
 *   computer and stayed away over three minutes comes back watching — the
 *   server returned the lease, and the status hook follows it;
 * - the lease is followed without reconnecting (the server re-checks every
 *   input message; `viewOnly` keeps the page honest).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { WebView, WebViewMessageEvent } from 'react-native-webview';
import { computerViewToken, computerViewerUrl } from '../../api/bots';
import { getApiBase } from '../../store/stations';
import { readViewerMessage, viewerCommand, type HelperKey } from './viewer-html';

/** Reconnect attempts before the member gets a manual "Reconnect". */
export const MAX_RETRIES = 6;
const MAX_BACKOFF_MS = 15_000;

export function backoffDelay(failures: number): number {
  return Math.min(1000 * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
}

export type ScreenConnection = 'connecting' | 'connected' | 'reconnecting' | 'paused' | 'failed';

export interface ComputerScreenState {
  connection: ScreenConnection;
  /** Zoom over "fit" as the page last reported it (1 = the whole desktop). */
  zoom: number;
  webRef: React.RefObject<WebView | null>;
  onMessage: (event: WebViewMessageEvent) => void;
  /** After "failed": start over. */
  reconnect: () => void;
  sendKey: (key: HelperKey) => void;
  setZoom: (to: 'fit' | 'in' | 'out') => void;
}

export function useComputerScreen({
  enabled,
  viewOnly,
  onTapWhileWatching,
  onDisconnected,
}: {
  /** The computer runs and this screen is on view. */
  enabled: boolean;
  viewOnly: boolean;
  onTapWhileWatching?: () => void;
  /** The socket dropped — the computer may have stopped; refresh its status. */
  onDisconnected?: () => void;
}): ComputerScreenState {
  const webRef = useRef<WebView | null>(null);
  const [connection, setConnection] = useState<ScreenConnection>('connecting');
  const [zoom, setZoomState] = useState(1);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [generation, setGeneration] = useState(0);
  const viewOnlyRef = useRef(viewOnly);
  const handlers = useRef({ onTapWhileWatching, onDisconnected });
  handlers.current = { onTapWhileWatching, onDisconnected };
  /** The live attempt's callbacks for page messages (null between attempts). */
  const attempt = useRef<{ connected: () => void; dropped: () => void } | null>(null);

  const inject = useCallback((js: string) => webRef.current?.injectJavaScript(js), []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    if (!enabled || !active) {
      setConnection(enabled ? 'paused' : 'connecting');
      inject(viewerCommand('disconnect'));
      return undefined;
    }
    let cancelled = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const retry = () => {
      if (cancelled) return;
      failures += 1;
      if (failures > MAX_RETRIES) {
        setConnection('failed');
        return;
      }
      setConnection('reconnecting');
      timer = setTimeout(() => void connect(), backoffDelay(failures));
    };

    const connect = async () => {
      const ticket = await computerViewToken();
      if (cancelled) return;
      if (!ticket.ok) {
        // Refused (computer stopped, Bots off) or offline: same recovery — refresh, back off, retry.
        handlers.current.onDisconnected?.();
        retry();
        return;
      }
      inject(viewerCommand('viewOnly', viewOnlyRef.current));
      inject(viewerCommand('connect', computerViewerUrl(getApiBase(), ticket.value.token)));
    };

    attempt.current = {
      connected: () => {
        failures = 0;
        setConnection('connected');
      },
      dropped: () => {
        handlers.current.onDisconnected?.();
        retry();
      },
    };
    setConnection('connecting');
    void connect();
    return () => {
      cancelled = true;
      attempt.current = null;
      clearTimeout(timer);
      inject(viewerCommand('disconnect'));
    };
  }, [ready, enabled, active, generation, inject]);

  // Follow the lease without reconnecting.
  useEffect(() => {
    viewOnlyRef.current = viewOnly;
    if (ready) inject(viewerCommand('viewOnly', viewOnly));
  }, [viewOnly, ready, inject]);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    const message = readViewerMessage(event.nativeEvent.data);
    if (!message) return;
    switch (message.t) {
      case 'ready':
        // The page (re)loaded — also after iOS killed its web process: connect afresh.
        setReady(true);
        setGeneration((n) => n + 1);
        return;
      case 'connected':
        attempt.current?.connected();
        return;
      case 'disconnected':
        attempt.current?.dropped();
        return;
      case 'tap-view-only':
        handlers.current.onTapWhileWatching?.();
        return;
      case 'zoom':
        setZoomState(message.z);
    }
  }, []);

  const reconnect = useCallback(() => setGeneration((n) => n + 1), []);
  const sendKey = useCallback((key: HelperKey) => inject(viewerCommand('key', key)), [inject]);
  const setZoom = useCallback((to: 'fit' | 'in' | 'out') => inject(viewerCommand('zoom', to)), [inject]);

  return { connection, zoom, webRef, onMessage, reconnect, sendKey, setZoom };
}
