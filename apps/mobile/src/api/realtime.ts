/**
 * The realtime client — the one WebSocket to `/api/ws` (API v2). Message deltas, conversation
 * changes, runs, needs-you cards, notifications and computer states all arrive here as
 * `{ type, data }` events (RealtimeEvent in ../shared/contract.ts); sending still goes through
 * REST. The app's instance lives in src/realtime/index.ts; <RealtimeBridge/> starts it in the
 * foreground and stops it in the background.
 *
 * Everything platform-ish is injected (the WebSocket class, the URL and the token, token
 * refresh, timers, randomness) so the root vitest drives every close code with a fake socket
 * and a fake clock (./realtime.test.ts).
 *
 * Handshake: the socket opens, the client says `hello` with the access token (never in the
 * URL), and the server answers `ready` — only then is the status `open`, and every listener gets
 * a `resync` (events may have been missed while the socket was down: catch up over REST).
 *
 * Closing:
 * - our own close (stop: background, sign-out, station switch) → nothing more;
 * - 4401 (REALTIME_SIGN_IN_AGAIN: no hello in time, a token the server refuses, or a member
 *   disabled since) → one token refresh per connection cycle, then reconnect at once; a second
 *   4401 in the cycle, or a failed refresh → `stopped` (no sign-out from here: the next REST 401
 *   takes the app's usual path). An account the server will never accept cannot loop;
 * - anything else (1006, a server restart or deploy) → backoff 1 → 2 → 4 → 8 → 16 → 30 s,
 *   ±20 % jitter.
 * A "connection cycle" runs from `start()` until a connection has stayed open for 30 s; then
 * the backoff and the refresh allowance reset. The server keeps the socket alive with protocol
 * pings, which the platform answers by itself.
 *
 * Privacy: the token travels only in the hello frame and is never logged.
 */

import { REALTIME_SIGN_IN_AGAIN, type RealtimeEvent } from '../shared/contract';

/** A connection open this long ends the cycle: backoff and the refresh allowance reset. */
export const STABLE_MS = 30_000;
/** Reconnect delays after an unexpected close, then the last one forever. */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
/** ± share of each backoff delay, so many clients do not reconnect in step. */
export const BACKOFF_JITTER = 0.2;

export type RealtimeStatus = 'off' | 'connecting' | 'open' | 'backoff' | 'stopped';

/** What listeners get: the server's events, and `resync` after every `ready` (catch up). */
export type ClientEvent = Exclude<RealtimeEvent, { type: 'ready' }> | { type: 'resync'; reconnected: boolean };

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** `/api/ws` on the API's own host (http → ws, https → wss). */
export function realtimeUrl(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, '').replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s.toLowerCase()}://`);
  return `${base}/api/ws`;
}

const EVENT_TYPES: ReadonlySet<string> = new Set<RealtimeEvent['type']>([
  'ready',
  'message.created',
  'message.delta',
  'message.step',
  'message.updated',
  'message.deleted',
  'conversation.updated',
  'read.updated',
  'notes.updated',
  'run.updated',
  'request.updated',
  'notification.created',
  'notification.read',
  'computer.updated',
  'vault.updated',
  'doc.updated',
  'doc.presence',
  'comments.updated',
]);

/** A frame as one of the server's events, or null (malformed, or a type this app does not know). */
export function parseFrame(data: unknown): RealtimeEvent | null {
  if (typeof data !== 'string') return null;
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== 'object') return null;
  const event = frame as { type?: unknown; data?: unknown };
  if (typeof event.type !== 'string' || !EVENT_TYPES.has(event.type)) return null;
  if (!event.data || typeof event.data !== 'object') return null;
  return frame as RealtimeEvent;
}

export interface RealtimeClientDeps {
  WebSocketImpl: typeof WebSocket;
  /** Where to connect and with which token right now; null = cannot (signed out) — the client stops. */
  target: () => { url: string; token: string } | null;
  /** The app's single-flight token refresh; true = a new access token is in place. */
  refreshTokens: () => Promise<boolean>;
  clock: Clock;
  /** [0, 1) — the backoff jitter (Math.random by default). */
  random?: () => number;
}

export class RealtimeClient {
  private readonly deps: RealtimeClientDeps;
  private current: RealtimeStatus = 'off';
  private down: number;
  private socket: WebSocket | null = null;
  /** Bumped by start()/stop(): an async step from an earlier run (a refresh) must not act. */
  private run = 0;
  private wanted = false;
  /** Backoff step for the next unexpected close (reset by a stable connection). */
  private attempt = 0;
  /** A token refresh was spent in this connection cycle. */
  private refreshed = false;
  /** A `ready` came in this run already: the next one is a reconnect. */
  private readyBefore = false;
  private retryTimer: unknown = null;
  private stableTimer: unknown = null;
  private readonly handlers = new Set<(e: ClientEvent) => void>();
  private readonly statusListeners = new Set<(s: RealtimeStatus) => void>();

  constructor(deps: RealtimeClientDeps) {
    this.deps = deps;
    this.down = deps.clock.now();
  }

  get status(): RealtimeStatus {
    return this.current;
  }

  /** When the socket went down (null while open). */
  downSince(): number | null {
    return this.current === 'open' ? null : this.down;
  }

  on(handler: (e: ClientEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onStatus(listener: (s: RealtimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Connect (a new connection cycle). No-op while already connected or reconnecting. */
  start(): void {
    if (this.wanted && this.current !== 'stopped') return;
    this.wanted = true;
    this.run += 1;
    this.attempt = 0;
    this.refreshed = false;
    this.connect();
  }

  /** Close (1000) and stay closed until the next start(). A later start() counts as a reconnect. */
  stop(): void {
    this.wanted = false;
    this.run += 1;
    this.clearTimer('retryTimer');
    this.clearTimer('stableTimer');
    this.drop(1000);
    this.setStatus('off');
  }

  /** Reconnect now if the socket is waiting to (the network came back). */
  retry(): void {
    if (!this.wanted || this.socket || this.current === 'connecting') return;
    this.attempt = 0;
    this.connect();
  }

  // ─── Private ────────────────────────────────────────────

  private connect(): void {
    this.clearTimer('retryTimer');
    const target = this.deps.target();
    if (!target) {
      this.setStatus('stopped');
      return;
    }
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new this.deps.WebSocketImpl(target.url);
    } catch {
      this.backoff();
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      if (this.socket !== ws) return;
      try {
        ws.send(JSON.stringify({ type: 'hello', data: { token: target.token } }));
      } catch {
        /* closing — the close decides what is next */
      }
    };
    ws.onmessage = (event: { data?: unknown }) => {
      if (this.socket !== ws) return;
      const frame = parseFrame(event.data);
      if (!frame) return;
      if (frame.type === 'ready') {
        this.ready();
        return;
      }
      this.emit(frame);
    };
    // A close always follows an error; that is where the next step is decided.
    ws.onerror = () => {};
    ws.onclose = (event: { code?: number }) => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.closed(typeof event.code === 'number' ? event.code : 1006);
    };
  }

  private ready(): void {
    this.setStatus('open');
    this.clearTimer('stableTimer');
    this.stableTimer = this.deps.clock.setTimeout(() => {
      this.stableTimer = null;
      // Stable: the next drop starts a new cycle.
      this.attempt = 0;
      this.refreshed = false;
    }, STABLE_MS);
    const reconnected = this.readyBefore;
    this.readyBefore = true;
    this.emit({ type: 'resync', reconnected });
  }

  private closed(code: number): void {
    this.clearTimer('stableTimer');
    if (!this.wanted) {
      this.setStatus('off');
      return;
    }
    if (code === REALTIME_SIGN_IN_AGAIN) {
      if (this.refreshed) {
        this.setStatus('stopped');
        return;
      }
      this.refreshed = true;
      this.setStatus('backoff');
      const run = this.run;
      void this.deps
        .refreshTokens()
        .catch(() => false)
        .then((ok) => {
          if (run !== this.run || !this.wanted) return;
          if (ok) this.connect();
          else this.setStatus('stopped');
        });
      return;
    }
    this.backoff();
  }

  private backoff(): void {
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    const random = this.deps.random ?? Math.random;
    const delay = Math.round(base * (1 + (random() * 2 - 1) * BACKOFF_JITTER));
    this.setStatus('backoff');
    this.retryTimer = this.deps.clock.setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) this.connect();
    }, delay);
  }

  /** Close the socket and ignore anything it still reports. */
  private drop(code: number): void {
    const ws = this.socket;
    this.socket = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close(code);
    } catch {
      /* already closed */
    }
  }

  private emit(event: ClientEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch {
        /* a listener's failure must not take the socket down */
      }
    }
  }

  private setStatus(next: RealtimeStatus): void {
    if (next === this.current) return;
    if (this.current === 'open') this.down = this.deps.clock.now();
    this.current = next;
    for (const listener of [...this.statusListeners]) {
      try {
        listener(next);
      } catch {
        /* see emit */
      }
    }
  }

  private clearTimer(name: 'retryTimer' | 'stableTimer'): void {
    const handle = this[name];
    if (handle !== null) this.deps.clock.clearTimeout(handle);
    this[name] = null;
  }
}
