/**
 * The realtime client — one WebSocket to `/api/ws` (spec
 * docs/specs/20261008-mobile-bots.md §2.7.2, D6). The server only says "X
 * changed" over it (a run started / ended, a Bots conversation changed, the
 * pending-card count); content is always re-read over REST. Bots are the only
 * consumer in v1: the thread engines and the Bots sync (src/bots/sync.ts)
 * listen through the `Realtime` contract (src/bots/contract.ts). The app's
 * instance lives in src/realtime/index.ts; <RealtimeBridge/> starts it in the
 * foreground and stops it in the background.
 *
 * Everything platform-ish is injected (the WebSocket class, the URL, token
 * refresh, timers, randomness) so the root vitest can drive every close code
 * with a fake socket and a fake clock (./ws.test.ts).
 *
 * Status: off → connecting → open → (backoff | cooling | stopped). `open`
 * means the server accepted the token — its `connected` frame, not the
 * socket's open event: the server upgrades first and closes 4001 right after
 * when the token is bad.
 *
 * Frames: `ping` → answer `pong`; `connected` → status open + a `resync` to
 * every listener (pushes may have been missed while down); `chat:run`,
 * `bots:conversation`, `bots:attention` → delivered; anything else
 * (`notification:new`, `bots:computer`…) and malformed JSON → dropped.
 *
 * Closing:
 * - our own close (stop: background, sign-out, station switch) → nothing more;
 * - 4001 (bad / expired token at the handshake, revoked credentials, not an
 *   internal account) and 4002 (the token expired on an open socket) → one
 *   token refresh per connection cycle, then reconnect at once; a second
 *   4001/4002 in the cycle, or a failed refresh → `stopped` (no sign-out from
 *   here: the next REST 401 takes the app's usual path). An account the server
 *   will never accept cannot loop;
 * - 4003 (more than 10 sockets for this user — the oldest is closed) →
 *   `cooling` for 60 s before reconnecting, so the app and a web tab do not
 *   keep kicking each other off; the polling fallback covers the gap;
 * - anything else (1006, a server restart, our watchdog's 4000) → backoff
 *   1 → 2 → 4 → 8 → 16 → 30 s, ±20 % jitter.
 * A "connection cycle" runs from `start()` until a connection has stayed open
 * for 30 s; then the backoff and the refresh allowance reset.
 *
 * Watchdog: the server pings every 30 s; 70 s without any frame means a
 * half-open socket (React Native reports none) — it is dropped and replaced.
 *
 * Privacy: the URL carries the access token — it is never logged (nothing in
 * src/api logs).
 */

import type { Realtime, RealtimeEvent, RealtimeStatus, ServerWsWire, ThreadDeps } from '../bots/contract';

/** No frame at all for this long (the server pings every 30 s) = a dead socket. */
export const WATCHDOG_MS = 70_000;
/** A connection open this long ends the cycle: backoff and the refresh allowance reset. */
export const STABLE_MS = 30_000;
/** Wait after 4003 (too many sockets for this user) before trying again. */
export const COOLING_MS = 60_000;
/** Reconnect delays after an unexpected close, then the last one forever. */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
/** ± share of each backoff delay, so many clients do not reconnect in step. */
export const BACKOFF_JITTER = 0.2;
/** Close code the client uses when its watchdog gives up on a silent socket. */
export const WATCHDOG_CLOSE = 4000;

/** `/api/ws?token=…` on the API's own host (http → ws, https → wss). */
export function realtimeUrl(apiBase: string, token: string): string {
  const base = apiBase.replace(/\/+$/, '').replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s.toLowerCase()}://`);
  return `${base}/api/ws?token=${encodeURIComponent(token)}`;
}

/** A frame's payload as one of the events mobile reads, or null (dropped). */
export function parseFrame(data: unknown): ServerWsWire | null {
  if (typeof data !== 'string') return null;
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== 'object') return null;
  const f = frame as Record<string, unknown>;
  const text = (key: string) => typeof f[key] === 'string' && (f[key] as string).length > 0;
  switch (f.type) {
    case 'ping':
      return { type: 'ping' };
    case 'connected':
      return { type: 'connected', userId: typeof f.userId === 'string' ? f.userId : '' };
    case 'chat:run':
      if (!text('sessionId') || !text('runId')) return null;
      if (f.status !== 'running' && f.status !== 'completed' && f.status !== 'error') return null;
      return { type: 'chat:run', sessionId: f.sessionId as string, runId: f.runId as string, status: f.status };
    case 'bots:conversation':
      return text('sessionId') ? { type: 'bots:conversation', sessionId: f.sessionId as string } : null;
    case 'bots:attention':
      return typeof f.pending === 'number' && Number.isFinite(f.pending)
        ? { type: 'bots:attention', pending: f.pending }
        : null;
    default:
      return null;
  }
}

export interface RealtimeClientDeps {
  WebSocketImpl: typeof WebSocket;
  /** Where to connect right now (token included); null = cannot (signed out) — the client stops. */
  url: () => string | null;
  /** The app's single-flight token refresh; true = a new access token is in place. */
  refreshTokens: () => Promise<boolean>;
  clock: ThreadDeps['clock'];
  /** [0, 1) — the backoff jitter (Math.random by default). */
  random?: () => number;
}

export class RealtimeClient implements Realtime {
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
  private retryTimer: unknown = null;
  private watchdog: unknown = null;
  private stableTimer: unknown = null;
  private readonly handlers = new Set<(e: RealtimeEvent) => void>();
  private readonly statusListeners = new Set<(s: RealtimeStatus) => void>();

  constructor(deps: RealtimeClientDeps) {
    this.deps = deps;
    this.down = deps.clock.now();
  }

  get status(): RealtimeStatus {
    return this.current;
  }

  downSince(): number | null {
    return this.current === 'open' ? null : this.down;
  }

  on(handler: (e: RealtimeEvent) => void): () => void {
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

  /** Close (1000) and stay closed until the next start(). */
  stop(): void {
    this.wanted = false;
    this.run += 1;
    this.clearTimers();
    this.drop(1000);
    this.setStatus('off');
  }

  // ─── Private ────────────────────────────────────────────

  private connect(): void {
    this.clearTimer('retryTimer');
    const url = this.deps.url();
    if (!url) {
      this.setStatus('stopped');
      return;
    }
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new this.deps.WebSocketImpl(url);
    } catch {
      this.backoff();
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      if (this.socket === ws) this.armWatchdog();
    };
    ws.onmessage = (event: { data?: unknown }) => {
      if (this.socket !== ws) return;
      this.armWatchdog();
      this.frame(ws, event.data);
    };
    // A close always follows an error; that is where the next step is decided.
    ws.onerror = () => {};
    ws.onclose = (event: { code?: number }) => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.closed(typeof event.code === 'number' ? event.code : 1006);
    };
  }

  private frame(ws: WebSocket, data: unknown): void {
    const frame = parseFrame(data);
    if (!frame) return;
    switch (frame.type) {
      case 'ping':
        try {
          ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
          /* closing — the close decides what is next */
        }
        return;
      case 'connected':
        this.setStatus('open');
        this.clearTimer('stableTimer');
        this.stableTimer = this.deps.clock.setTimeout(() => {
          this.stableTimer = null;
          // Stable: the next drop starts a new cycle.
          this.attempt = 0;
          this.refreshed = false;
        }, STABLE_MS);
        this.emit({ type: 'resync' });
        return;
      default:
        this.emit(frame);
    }
  }

  private closed(code: number): void {
    this.clearTimer('watchdog');
    this.clearTimer('stableTimer');
    if (!this.wanted) {
      this.setStatus('off');
      return;
    }
    if (code === 4001 || code === 4002) {
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
    if (code === 4003) {
      this.setStatus('cooling');
      this.retryTimer = this.deps.clock.setTimeout(() => {
        this.retryTimer = null;
        if (this.wanted) this.connect();
      }, COOLING_MS);
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

  private armWatchdog(): void {
    this.clearTimer('watchdog');
    this.watchdog = this.deps.clock.setTimeout(() => {
      this.watchdog = null;
      // A half-open socket may never report its close: let go of it and reconnect now.
      this.clearTimer('stableTimer');
      this.drop(WATCHDOG_CLOSE);
      if (this.wanted) this.backoff();
    }, WATCHDOG_MS);
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

  private emit(event: RealtimeEvent): void {
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

  private clearTimer(name: 'retryTimer' | 'watchdog' | 'stableTimer'): void {
    const handle = this[name];
    if (handle !== null) this.deps.clock.clearTimeout(handle);
    this[name] = null;
  }

  private clearTimers(): void {
    this.clearTimer('retryTimer');
    this.clearTimer('watchdog');
    this.clearTimer('stableTimer');
  }
}
