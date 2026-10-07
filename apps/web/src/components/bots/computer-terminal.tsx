/**
 * The computer's terminal — xterm.js over `WS /api/ws/computer-terminal?token=…`.
 *
 * A login shell as uid agent in ~/work, inside a tmux session the computer
 * keeps: reloading the page (or reconnecting) reattaches to the same shell.
 * It is the Bots' sandbox, not the screen, so it needs no take-over lease.
 *
 * Wire protocol (spec 20261007 §2.3): keystrokes go up as binary frames,
 * `{"type":"resize","cols","rows"}` as a text frame whenever the terminal is
 * fitted (and once on connect); the server answers with raw PTY output as
 * binary frames.
 *
 * The connection follows the live screen's rules: a fresh one-time ticket per
 * (re)connect, exponential backoff (1 s → 15 s) and a manual "Reconnect" after
 * that, a disconnect after a minute in a background tab. Close codes (the
 * viewer's): a stale ticket (4001), the computer going away (4009, 4010) or the
 * shell exiting (1011) reconnect with a fresh ticket — tmux keeps the session;
 * a fifth terminal of the same member (4009 `too_many`) and Bots switched off
 * (4003) wait for the member instead.
 *
 * xterm owns the DOM inside `hostRef`; React never renders children there.
 */

import { useEffect, useRef, useState } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { ITheme, Terminal } from '@xterm/xterm';
import { Button, Spinner } from '../ui';
import { WifiOff } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { computerTerminalUrl, createComputerTerminalToken } from '../../lib/api/bots';
import { loadXterm } from '../../lib/xterm/loader';
import { MAX_RETRIES, backoffDelay, useBackgrounded } from './computer-screen';

export type TerminalConnection =
  | 'loading'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'paused'
  | 'failed'
  | 'too_many';

/** WebSocket.OPEN, without depending on the global (tests swap it). */
const WS_OPEN = 1;
/** VIEWER_CLOSE.forbidden: Bots are switched off for the member — retrying cannot help. */
const CLOSE_FORBIDDEN = 4003;
/** VIEWER_CLOSE.unavailable — with reason `too_many`, the member already has 4 terminals open. */
const CLOSE_UNAVAILABLE = 4009;

const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 13,
  lineHeight: 1.15,
  scrollback: 5000,
  macOptionIsMeta: true,
  // ANSI colours are picked for dark terminals; keep them readable on the
  // light theme's pale background too (WCAG AA).
  minimumContrastRatio: 4.5,
} as const;

function readThemeVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** xterm draws on its own, so it gets literal colours — read from the design tokens (and re-read on a theme switch). */
export function terminalTheme(): ITheme {
  const background = readThemeVar('--t-surface-sunken', '#eef3ea');
  return {
    background,
    foreground: readThemeVar('--t-fg', '#1f2a20'),
    cursor: readThemeVar('--t-primary-fg', '#2e8b3d'),
    cursorAccent: background,
    selectionBackground: readThemeVar('--t-primary-subtle-hover', '#d8e7cc'),
  };
}

function monoFont(): string {
  return readThemeVar('--font-mono', 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace');
}

/** The resize message the server turns into TIOCSWINSZ + SIGWINCH. */
export function resizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ type: 'resize', cols, rows });
}

function fitQuietly(fit: FitAddon | null): void {
  try {
    fit?.fit();
  } catch {
    // Not laid out yet (hidden tab) — the next fit catches up.
  }
}

export interface ComputerTerminalProps {
  /** The Terminal tab is the one showing: fit to the pane and follow its size. */
  active: boolean;
  /** The socket dropped — the computer may have stopped; let the owner refresh its status. */
  onDisconnected?: () => void;
}

export function ComputerTerminal({ active, onDisconnected }: ComputerTerminalProps) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const onDisconnectedRef = useRef(onDisconnected);
  onDisconnectedRef.current = onDisconnected;
  const [ready, setReady] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [connection, setConnection] = useState<TerminalConnection>('loading');
  const [generation, setGeneration] = useState(0);
  const backgrounded = useBackgrounded();

  // ── The terminal itself: one per load attempt, for as long as the tab lives ──
  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    const encoder = new TextEncoder();
    const send = (payload: Uint8Array | string) => {
      const socket = socketRef.current;
      if (socket && socket.readyState === WS_OPEN) socket.send(payload);
    };
    setConnection('loading');
    loadXterm()
      .then(({ Terminal: XtermTerminal, FitAddon: XtermFitAddon }) => {
        const host = hostRef.current;
        if (disposed || !host) return;
        term = new XtermTerminal({ ...TERMINAL_OPTIONS, fontFamily: monoFont(), theme: terminalTheme() });
        const fit = new XtermFitAddon();
        term.loadAddon(fit);
        term.open(host);
        // Typed (and pasted) text as UTF-8; binary-mode mouse reports as their raw bytes.
        term.onData((data) => send(encoder.encode(data)));
        term.onBinary((data) => send(Uint8Array.from(data, (char) => char.charCodeAt(0) & 0xff)));
        term.onResize(({ cols, rows }) => send(resizeFrame(cols, rows)));
        termRef.current = term;
        fitRef.current = fit;
        setReady(true);
      })
      .catch(() => {
        if (!disposed) setConnection('failed');
      });
    return () => {
      disposed = true;
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
      setReady(false);
    };
  }, [loadAttempt]);

  // ── The connection: a fresh ticket per attempt, paused in a background tab ──
  useEffect(() => {
    if (!ready) return;
    if (backgrounded) {
      setConnection('paused');
      return;
    }
    let cancelled = false;
    let failures = 0;
    let retryTimer: number | undefined;
    let socket: WebSocket | null = null;

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
        const { token } = await createComputerTerminalToken();
        if (cancelled) return;
        const ws = new WebSocket(computerTerminalUrl(token));
        ws.binaryType = 'arraybuffer';
        socket = ws;
        socketRef.current = ws;
        ws.onopen = () => {
          if (cancelled) return;
          failures = 0;
          setConnection('connected');
          // The PTY starts at its own size: tell it ours (refit first — the pane may have moved).
          fitQuietly(fitRef.current);
          const term = termRef.current;
          if (term) ws.send(resizeFrame(term.cols, term.rows));
        };
        ws.onmessage = (event: MessageEvent) => {
          const term = termRef.current;
          if (!term) return;
          if (typeof event.data === 'string') term.write(event.data);
          else if (event.data instanceof ArrayBuffer) term.write(new Uint8Array(event.data));
        };
        ws.onclose = (event: CloseEvent) => {
          if (socketRef.current === ws) socketRef.current = null;
          if (socket === ws) socket = null;
          if (cancelled) return;
          if (event.code === CLOSE_UNAVAILABLE && event.reason.includes('too_many')) {
            // Retrying would only be refused again: the member closes one elsewhere first.
            setConnection('too_many');
            return;
          }
          if (event.code === CLOSE_FORBIDDEN) {
            setConnection('failed');
            return;
          }
          onDisconnectedRef.current?.();
          scheduleRetry();
        };
      } catch {
        // Ticket refused (the computer stopped, Bots switched off): tell the owner, back off, try again.
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
      if (socket) {
        socket.onclose = null;
        socket.close(1000);
      }
      socketRef.current = null;
    };
  }, [ready, backgrounded, generation]);

  // ── Fit to the pane while showing, and follow its size ──
  useEffect(() => {
    if (!ready || !active) return;
    let frame = 0;
    const refit = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => fitQuietly(fitRef.current));
    };
    refit();
    const host = hostRef.current;
    const observer = host && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refit) : null;
    if (host) observer?.observe(host);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [ready, active]);

  // ── Theme switches (and Branding Studio overrides) re-colour the terminal ──
  useEffect(() => {
    if (!ready) return;
    const observer = new MutationObserver(() => {
      const term = termRef.current;
      if (term) term.options.theme = terminalTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return () => observer.disconnect();
  }, [ready]);

  const reconnect = () => {
    if (ready) setGeneration((n) => n + 1);
    else setLoadAttempt((n) => n + 1);
  };

  const overlay =
    connection === 'connected' ? null : connection === 'failed' || connection === 'too_many' ? (
      <div className="flex max-w-xs flex-col items-center gap-2 text-center">
        <WifiOff size={20} className="text-fg-muted" aria-hidden="true" />
        <p className="text-sm text-fg-secondary">
          {connection === 'too_many' ? t('botsComputer.terminal_tooMany') : t('botsComputer.terminal_failed')}
        </p>
        <Button size="sm" variant="outline" onClick={reconnect} data-testid="computer-terminal-reconnect">
          {t('botsComputer.reconnect')}
        </Button>
      </div>
    ) : connection === 'paused' ? (
      <p className="max-w-xs text-center text-sm text-fg-muted">{t('botsComputer.terminal_paused')}</p>
    ) : (
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        <Spinner />
        <span>
          {connection === 'reconnecting' ? t('botsComputer.reconnecting') : t('botsComputer.terminal_connecting')}
        </span>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="computer-terminal" data-connection={connection}>
      <div className="relative min-h-[240px] flex-1 overflow-hidden rounded-lg border border-edge bg-surface-sunken">
        {/* The padding sits outside the host: the fit addon measures the host's own box. */}
        <div className="absolute inset-0 p-2">
          <div ref={hostRef} className="h-full w-full" />
        </div>
        {overlay && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-sunken/90 p-4">{overlay}</div>
        )}
      </div>
      <p className="text-[11px] leading-4 text-fg-faint">{t('botsComputer.terminal_note')}</p>
    </div>
  );
}
