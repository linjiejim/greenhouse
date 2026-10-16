/**
 * The live screen's connection, owned by the app (the page in ./viewer-html.ts only draws):
 * mint a one-time ticket with the member's bearer token (`view` to watch, `control` to take
 * over — the server drops input on a view ticket), hand the page the socket URL, and keep it
 * honest:
 *
 * - every (re)connect mints a fresh ticket (one minute, one socket), so a dropped socket never
 *   retries with a spent one;
 * - watching and taking over are the same picture: switching reconnects with the other ticket;
 * - unexpected drops back off 1 s → 15 s, and after MAX_RETRIES the member gets "Reconnect";
 * - the app in the background drops the socket at once (iOS suspends the WebView anyway); back
 *   in front it reconnects.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { WebView, WebViewMessageEvent } from 'react-native-webview';
import { computerSocketUrl, computerTicket } from '../api/computer';
import { getApiBase } from '../store/stations';
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
  /** Types text into whatever has the focus on the computer (key by key). */
  type: (text: string) => void;
  setZoom: (to: 'fit' | 'in' | 'out') => void;
}

export function useComputerScreen({
  agentId,
  enabled,
  control,
  onTapWhileWatching,
  onDisconnected,
}: {
  agentId: string;
  /** The computer runs and this screen is on view. */
  enabled: boolean;
  /** Taken over: input goes to the computer. */
  control: boolean;
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
      const ticket = await computerTicket(agentId, control ? 'control' : 'view');
      if (cancelled) return;
      if (!ticket.ok) {
        // Refused (the computer stopped, no access) or offline: refresh, back off, retry.
        handlers.current.onDisconnected?.();
        retry();
        return;
      }
      inject(viewerCommand('viewOnly', !control));
      inject(viewerCommand('connect', computerSocketUrl(getApiBase(), ticket.data.ticket)));
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
  }, [ready, enabled, active, generation, inject, agentId, control]);

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
  const type = useCallback((text: string) => inject(viewerCommand('type', text)), [inject]);
  const setZoom = useCallback((to: 'fit' | 'in' | 'out') => inject(viewerCommand('zoom', to)), [inject]);

  return { connection, zoom, webRef, onMessage, reconnect, sendKey, type, setZoom };
}
