/**
 * Live screen of the member's computer — a noVNC RFB client over
 * `WS /api/ws/computer?token=…`.
 *
 * Connection lifecycle:
 * - Every (re)connect fetches a fresh one-time view token (60 s, single use),
 *   so a dropped socket never retries with a spent ticket.
 * - Unexpected disconnects retry with exponential backoff (1 s → 15 s cap);
 *   after MAX_RETRIES the member gets a manual "Reconnect".
 * - A tab hidden for 60 s disconnects (R19): forgotten tabs must not keep the
 *   computer awake or hold a slot. Coming back reconnects.
 *
 * View-only is enforced by the server (it drops input messages unless this
 * member holds the lease); `viewOnly` here keeps the client honest and lets a
 * click on the screen explain why nothing happened.
 *
 * noVNC owns the DOM inside `targetRef` — React never renders children there.
 */

import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button, Spinner } from '../ui';
import { LogIn, WifiOff } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { computerViewerUrl, createComputerViewToken } from '../../lib/api/bots';
import { loadRfb } from '../../lib/novnc/loader';
import { RFB_KEY_CODES, RFB_KEYSYMS, type RfbClient, type RfbHelperKey } from '../../lib/novnc/types';

/** Reconnect attempts before the member gets a manual "Reconnect" (the terminal uses the same budget). */
export const MAX_RETRIES = 6;
const MAX_BACKOFF_MS = 15_000;
const HIDDEN_DISCONNECT_MS = 60_000;
const HINT_MS = 3_000;

export type ScreenConnection = 'connecting' | 'connected' | 'reconnecting' | 'paused' | 'failed';

export interface ComputerScreenHandle {
  /** Press a helper key on the remote screen (no-op while view-only). */
  sendKey: (key: RfbHelperKey) => void;
  focus: () => void;
}

interface ComputerScreenProps {
  viewOnly: boolean;
  /** Offered in the "view only" hint after a click on the screen. */
  onTakeOver?: () => void;
  /** The socket dropped — the computer may have stopped; let the owner refresh its status. */
  onDisconnected?: () => void;
  className?: string;
}

export function backoffDelay(failures: number): number {
  return Math.min(1000 * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
}

/**
 * True once the page has been in the background for a minute (R19): forgotten
 * tabs must not keep the computer awake or hold a slot. Back in front → false,
 * and the owner reconnects.
 */
export function useBackgrounded(afterMs = HIDDEN_DISCONNECT_MS): boolean {
  const [backgrounded, setBackgrounded] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'hidden') {
        timer = window.setTimeout(() => setBackgrounded(true), afterMs);
      } else {
        setBackgrounded(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [afterMs]);
  return backgrounded;
}

export const ComputerScreen = forwardRef<ComputerScreenHandle, ComputerScreenProps>(function ComputerScreen(
  { viewOnly, onTakeOver, onDisconnected, className = '' },
  ref,
) {
  const t = useT();
  const targetRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RfbClient | null>(null);
  const viewOnlyRef = useRef(viewOnly);
  const onDisconnectedRef = useRef(onDisconnected);
  const [connection, setConnection] = useState<ScreenConnection>('connecting');
  const [generation, setGeneration] = useState(0);
  const backgrounded = useBackgrounded();
  const [hint, setHint] = useState(false);

  onDisconnectedRef.current = onDisconnected;

  useImperativeHandle(
    ref,
    () => ({
      sendKey: (key) => {
        rfbRef.current?.sendKey(RFB_KEYSYMS[key], RFB_KEY_CODES[key]);
        rfbRef.current?.focus({ preventScroll: true });
      },
      focus: () => rfbRef.current?.focus({ preventScroll: true }),
    }),
    [],
  );

  useEffect(() => {
    if (backgrounded) {
      setConnection('paused');
      return;
    }
    let cancelled = false;
    let failures = 0;
    let retryTimer: number | undefined;
    let client: RfbClient | null = null;

    const scheduleRetry = () => {
      if (cancelled) return;
      failures += 1;
      if (failures > MAX_RETRIES) {
        setConnection('failed');
        return;
      }
      setConnection('reconnecting');
      retryTimer = window.setTimeout(() => void connect(), backoffDelay(failures));
    };

    const connect = async () => {
      try {
        const [{ token }, RFB] = await Promise.all([createComputerViewToken(), loadRfb()]);
        const target = targetRef.current;
        if (cancelled || !target) return;
        const rfb = new RFB(target, computerViewerUrl(token), { shared: true });
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.clipViewport = false;
        // The container's semantic surface shows through instead of noVNC's dark grey.
        rfb.background = 'transparent';
        rfb.viewOnly = viewOnlyRef.current;
        rfb.focusOnClick = !viewOnlyRef.current;
        rfb.addEventListener('connect', () => {
          if (cancelled) return;
          failures = 0;
          setConnection('connected');
        });
        rfb.addEventListener('disconnect', () => {
          if (rfbRef.current === rfb) rfbRef.current = null;
          if (client === rfb) client = null;
          if (cancelled) return;
          onDisconnectedRef.current?.();
          scheduleRetry();
        });
        client = rfb;
        rfbRef.current = rfb;
      } catch {
        // Token refused (computer stopped, lease checks) or the library failed
        // to load: same recovery — tell the owner, back off, try again.
        if (cancelled) return;
        onDisconnectedRef.current?.();
        scheduleRetry();
      }
    };

    setConnection('connecting');
    void connect();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      client?.disconnect();
      rfbRef.current = null;
    };
  }, [backgrounded, generation]);

  // Follow the lease without reconnecting: the server re-checks it per message.
  useEffect(() => {
    viewOnlyRef.current = viewOnly;
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.viewOnly = viewOnly;
    rfb.focusOnClick = !viewOnly;
    if (!viewOnly) rfb.focus({ preventScroll: true });
    else rfb.blur();
  }, [viewOnly, connection]);

  useEffect(() => {
    if (!viewOnly) setHint(false);
  }, [viewOnly]);

  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(false), HINT_MS);
    return () => window.clearTimeout(timer);
  }, [hint]);

  const overlay =
    connection === 'connected' ? null : connection === 'failed' ? (
      <div className="flex flex-col items-center gap-2 text-center">
        <WifiOff size={20} className="text-fg-muted" aria-hidden="true" />
        <p className="text-sm text-fg-secondary">{t('botsComputer.connectFailed')}</p>
        <Button size="sm" variant="outline" onClick={() => setGeneration((n) => n + 1)}>
          {t('botsComputer.reconnect')}
        </Button>
      </div>
    ) : connection === 'paused' ? (
      <p className="max-w-xs text-center text-sm text-fg-muted">{t('botsComputer.paused')}</p>
    ) : (
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        <Spinner />
        <span>{connection === 'reconnecting' ? t('botsComputer.reconnecting') : t('botsComputer.connecting')}</span>
      </div>
    );

  return (
    <div
      className={`relative overflow-hidden rounded-lg border border-edge bg-surface-sunken ${className}`}
      data-testid="computer-screen"
      data-connection={connection}
      data-view-only={viewOnly ? 'true' : 'false'}
    >
      <div ref={targetRef} className="absolute inset-0" />
      {viewOnly && connection === 'connected' && (
        // Catches clicks the server would drop anyway, so the member learns why.
        <div className="absolute inset-0 cursor-default" onPointerDown={() => setHint(true)} aria-hidden="true" />
      )}
      {overlay && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-sunken/90">{overlay}</div>
      )}
      {hint && (
        <div
          role="status"
          className="absolute inset-x-0 bottom-3 mx-auto flex w-max max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full border border-edge bg-surface-raised py-1 pl-3 pr-1 text-xs text-fg-secondary shadow-sm animate-fade-in"
        >
          <span className="truncate">{t('botsComputer.viewOnlyHint')}</span>
          {onTakeOver && (
            <Button size="sm" className="rounded-full" onClick={onTakeOver}>
              <LogIn size={12} className="mr-1" aria-hidden="true" />
              {t('botsComputer.takeOver')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
});
