/**
 * Terminal — WS /api/ws/computer-terminal?token=<one-time ticket> (spec
 * 20261007 §2.3).
 *
 * The member's own shell on their computer: uid `agent` — the same sandbox and
 * ~/work as the Bots' shell — inside a tmux session that outlives the socket,
 * so a page reload comes back to the same shell (`gh-term`, image contract
 * 2). The API tunnels it through `docker exec -i -u agent … gh-term`, so the
 * computer still publishes no port. It is not the screen: no take-over lease
 * is needed, and a take-over's kill (gh-agent-kill) spares it. The exec runs
 * in the home, not ~/work: gh-term creates ~/work and starts the shell there
 * itself, while `docker exec -w` into a folder the member deleted would fail
 * before gh-term runs — locking them out of the one tool that fixes it.
 *
 * Wire format. Client → server: a binary message is keystrokes, a text
 * message is `{"type":"resize","cols","rows"}`; anything else closes the
 * socket with 1008. Server → client: the terminal's raw output, binary.
 * Towards gh-term every input becomes one frame — type u8, length u32
 * big-endian, payload: type 0 = bytes for the PTY, type 1 = the resize JSON
 * `{"cols","rows"}`, clamped here as gh-term clamps it.
 *
 * Per connection, as the viewer (viewer.ts): the ticket (its own purpose — a
 * viewer ticket never opens a terminal) is verified and consumed, the member
 * re-read at open and every 60 s; pings every 20 s drop a browser that stopped
 * answering; the viewer heartbeat every 20 s keeps the computer awake while a
 * terminal is open (opening one starts the computer, even over the soft disk
 * limit); a slow browser pauses the tunnel. At most four terminals per member
 * in this process — a fifth closes with 4009 `too_many`. Purge, suspend and
 * shutdown close them; the computer stopping ends the tunnel (1011). Close
 * codes are the viewer's (VIEWER_CLOSE).
 */

import { Hono } from 'hono';
import { upgradeWebSocket } from '@hono/node-server';
import type { WSContext } from 'hono/ws';
import type { WebSocket as WsSocket } from 'ws';
import { getDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';

import type { ComputerProcess } from './host.js';
import { ComputerUnavailableError } from './errors.js';
import { computerLifecycleHooks } from './hooks.js';
import { requireComputerRuntime } from './runtime.js';
import { agentEnv } from './shell.js';
import { TERMINAL_TOKEN_PURPOSE, ticketHolderStatus, verifyViewToken, type ViewTokenClaims } from './view-token.js';
import { VIEWER_CLOSE } from './viewer.js';

const PING_MS = 20_000;
const HEARTBEAT_MS = 20_000;
const REVALIDATE_MS = 60_000;
export const MAX_TERMINALS_PER_MEMBER = 4;
/** Pause the tunnel above this much unsent output; resume below the low mark. */
const HIGH_WATER_BYTES = 1024 * 1024;
const LOW_WATER_BYTES = 256 * 1024;
/** Keystrokes (framed) held while the computer starts. */
const MAX_PENDING_BYTES = 64 * 1024;
/** One client message — a paste — at most. */
export const MAX_INPUT_MESSAGE_BYTES = 1024 * 1024;
/** Input gh-term has not taken yet; beyond it the client is flooding, not typing. */
const MAX_UNWRITTEN_INPUT_BYTES = 8 * 1024 * 1024;
/** A resize message is tiny; anything longer is not one. */
const MAX_CONTROL_CHARS = 256;

export const TERMINAL_ARGV = ['gh-term'];
export const TERMINAL_CWD = '/home/agent';

/** gh-term's stdin frame types (image contract 2, §1.5). */
export const TERMINAL_FRAME = { data: 0, resize: 1 } as const;
export const TERMINAL_COLS = { min: 10, max: 500 } as const;
export const TERMINAL_ROWS = { min: 5, max: 200 } as const;

/** One gh-term stdin frame: type u8, payload length u32 big-endian, payload. */
export function terminalFrame(type: number, payload: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(Math.max(value, range.min), range.max);
}

/** A client text message → the resize frame, or null when it is not `{"type":"resize","cols","rows"}`. */
export function resizeFrame(text: string): Buffer | null {
  if (text.length > MAX_CONTROL_CHARS) return null;
  const message = safeJsonParse(text, null) as { type?: unknown; cols?: unknown; rows?: unknown } | null;
  if (!message || typeof message !== 'object' || message.type !== 'resize') return null;
  const { cols, rows } = message;
  if (typeof cols !== 'number' || typeof rows !== 'number' || !Number.isInteger(cols) || !Number.isInteger(rows)) {
    return null;
  }
  const payload = JSON.stringify({ cols: clamp(cols, TERMINAL_COLS), rows: clamp(rows, TERMINAL_ROWS) });
  return terminalFrame(TERMINAL_FRAME.resize, Buffer.from(payload));
}

// ─── Live terminals (per member, this process) ────────────

interface Terminal {
  userId: string;
  close(code: number, reason: string): void;
}

const terminals = new Map<string, Set<Terminal>>();

function register(terminal: Terminal): void {
  let set = terminals.get(terminal.userId);
  if (!set) terminals.set(terminal.userId, (set = new Set()));
  set.add(terminal);
}

function unregister(terminal: Terminal): void {
  const set = terminals.get(terminal.userId);
  if (!set) return;
  set.delete(terminal);
  if (set.size === 0) terminals.delete(terminal.userId);
}

/** Close every terminal of a member in this process (purge, suspend). */
export function closeTerminalsFor(userId: string, reason = 'closed'): number {
  const list = [...(terminals.get(userId) ?? [])];
  for (const terminal of list) terminal.close(VIEWER_CLOSE.closedByServer, reason);
  return list.length;
}

export function terminalCount(userId: string): number {
  return terminals.get(userId)?.size ?? 0;
}

function rejectSocket(code: number, reason: string) {
  return {
    onOpen(_evt: Event, ws: WSContext) {
      ws.close(code, reason);
    },
  };
}

export function createComputerTerminalRoutes() {
  return new Hono().get(
    '/',
    upgradeWebSocket(async (c) => {
      const claims = verifyViewToken(new URL(c.req.url).searchParams.get('token'), {
        purpose: TERMINAL_TOKEN_PURPOSE,
      });
      if (!claims) return rejectSocket(VIEWER_CLOSE.unauthorized, 'invalid ticket');
      const allowed = await ticketHolderStatus(claims.uid, claims.av).catch(() => 'unauthorized' as const);
      if (allowed !== 'ok') {
        return rejectSocket(allowed === 'forbidden' ? VIEWER_CLOSE.forbidden : VIEWER_CLOSE.unauthorized, allowed);
      }
      return terminalSession(claims);
    }),
  );
}

/** The socket handlers of one verified terminal (exported for tests). */
export function terminalSession(claims: Pick<ViewTokenClaims, 'uid' | 'av' | 'c'>) {
  const userId = claims.uid;

  let raw: WsSocket | null = null;
  let child: ComputerProcess | null = null;
  let closed = false;
  /** Any frame or pong since the last ping proves the browser is still there. */
  let alive = true;
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  const timers: NodeJS.Timeout[] = [];

  const terminal: Terminal = {
    userId,
    close(code, reason) {
      if (closed) return;
      try {
        raw?.close(code, reason);
      } catch {
        /* already closing */
      }
      cleanup();
    },
  };

  function cleanup(): void {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearInterval(timer);
    unregister(terminal);
    if (child) {
      const tunnel = child;
      child = null;
      // EOF first: gh-term detaches and the tmux session (the shell) stays for
      // the next connection; the kill only backs that up.
      tunnel.stdin?.end();
      if (tunnel.exitCode === null && tunnel.signalCode === null) {
        const kill = setTimeout(() => tunnel.kill('SIGKILL'), 2_000);
        kill.unref?.();
        tunnel.once('exit', () => clearTimeout(kill));
      }
    }
  }

  // onOpen awaits (start, heartbeat) and the socket may close meanwhile —
  // cleanup() has then already run. Every resource onOpen creates goes
  // through one of these, so nothing outlives a socket that is gone.
  function trackTimer(timer: NodeJS.Timeout): void {
    timer.unref?.();
    if (closed) clearInterval(timer);
    else timers.push(timer);
  }
  function adoptChild(tunnel: ComputerProcess): boolean {
    if (closed) {
      tunnel.kill('SIGKILL');
      return false;
    }
    child = tunnel;
    return true;
  }

  function writeToTunnel(frames: Buffer[]): void {
    const stdin = child?.stdin;
    if (!stdin) return;
    for (const frame of frames) stdin.write(frame);
    if (stdin.writableLength > MAX_UNWRITTEN_INPUT_BYTES) {
      terminal.close(VIEWER_CLOSE.protocol, 'too much input');
    }
  }

  function pumpTunnel(tunnel: ComputerProcess, socket: WsSocket): void {
    let stderr = '';
    tunnel.stdout!.on('data', (chunk: Buffer) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(chunk, { binary: true });
      if (socket.bufferedAmount > HIGH_WATER_BYTES) {
        tunnel.stdout!.pause();
        const wait = setInterval(() => {
          if (closed || socket.bufferedAmount < LOW_WATER_BYTES) {
            clearInterval(wait);
            if (!closed) tunnel.stdout!.resume();
          }
        }, 50);
      }
    });
    tunnel.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < 2048) stderr += chunk.toString('utf8');
    });
    tunnel.on('error', () => terminal.close(VIEWER_CLOSE.tunnelClosed, 'tunnel failed'));
    tunnel.on('exit', (code) => {
      // The shell exiting (`exit`) ends gh-term with its code; a broken image
      // or a missing ~/work shows up here too, so leave a trace for operators.
      if (code !== 0 && !closed) {
        logger.warn('[bots-computer] terminal ended', { user_id: userId, code, stderr: stderr.trim().slice(-300) });
      }
      terminal.close(VIEWER_CLOSE.tunnelClosed, 'terminal closed');
    });
  }

  return {
    async onOpen(_evt: Event, ws: WSContext) {
      const socket = ws.raw as WsSocket;
      raw = socket;
      socket.on('pong', () => {
        alive = true;
      });
      // Counted and registered before the first await: concurrent opens cannot slip past the cap.
      if (terminalCount(userId) >= MAX_TERMINALS_PER_MEMBER) {
        terminal.close(VIEWER_CLOSE.unavailable, 'too_many');
        return;
      }
      register(terminal);
      const db = getDb();
      try {
        const { controller, host, config } = requireComputerRuntime();
        // Opening a terminal may start the computer, even over the soft disk
        // limit — a shell is how a member cleans up.
        const row = await controller.ensureRunning(userId, { allowOverQuota: true });
        if (closed) return;
        if (row.container_name !== claims.c) {
          terminal.close(VIEWER_CLOSE.unauthorized, 'stale ticket');
          return;
        }
        await db.botComputers.heartbeatViewer(userId);
        // Nothing below awaits; a socket gone during the awaits above stops here.
        if (closed) return;
        const tunnel = host.execStream(row.container_name, 'agent', TERMINAL_ARGV, {
          cwd: TERMINAL_CWD,
          // The proxy a Bot's shell gets: the member's terminal reaches the same internet.
          env: agentEnv(config.proxy),
        });
        if (!adoptChild(tunnel)) return;
        pumpTunnel(tunnel, socket);
        writeToTunnel(pending.splice(0));
        pendingBytes = 0;
      } catch (err) {
        const code = err instanceof ComputerUnavailableError ? err.code : 'unavailable';
        if (!(err instanceof ComputerUnavailableError)) {
          logger.warn(`[bots-computer] terminal could not open: ${toErrorMessage(err)}`);
        }
        terminal.close(VIEWER_CLOSE.unavailable, code);
        return;
      }
      if (closed) return;

      trackTimer(
        setInterval(() => {
          if (!alive) {
            // terminate(), not close(): a half-open peer never answers the close frame.
            logger.info('[bots-computer] terminal missed a pong; dropping it', { user_id: userId });
            try {
              raw?.terminate();
            } catch {
              /* already gone */
            }
            cleanup();
            return;
          }
          alive = false;
          try {
            raw?.ping();
          } catch {
            /* closing */
          }
        }, PING_MS),
      );
      trackTimer(
        setInterval(() => {
          void db.botComputers.heartbeatViewer(userId).catch(() => {});
        }, HEARTBEAT_MS),
      );
      trackTimer(
        setInterval(() => {
          void ticketHolderStatus(userId, claims.av)
            .then((result) => {
              if (result !== 'ok') terminal.close(VIEWER_CLOSE.unauthorized, result);
            })
            .catch(() => {});
        }, REVALIDATE_MS),
      );
    },

    onMessage(evt: MessageEvent) {
      if (closed) return;
      alive = true;
      let frame: Buffer | null;
      if (typeof evt.data === 'string') {
        frame = resizeFrame(evt.data);
        if (!frame) {
          terminal.close(VIEWER_CLOSE.protocol, 'unknown message');
          return;
        }
      } else {
        const bytes = new Uint8Array(evt.data as ArrayBuffer);
        if (bytes.length > MAX_INPUT_MESSAGE_BYTES) {
          terminal.close(VIEWER_CLOSE.protocol, 'message too large');
          return;
        }
        if (bytes.length === 0) return;
        frame = terminalFrame(TERMINAL_FRAME.data, bytes);
      }
      if (!child) {
        pendingBytes += frame.length;
        if (pendingBytes > MAX_PENDING_BYTES) {
          terminal.close(VIEWER_CLOSE.protocol, 'too much input before the terminal was ready');
          return;
        }
        pending.push(frame);
      } else {
        writeToTunnel([frame]);
      }
    },

    onClose() {
      cleanup();
    },

    onError() {
      cleanup();
    },
  };
}

computerLifecycleHooks.onPurged((userId) => {
  closeTerminalsFor(userId, 'computer removed');
});
computerLifecycleHooks.onShutdown(async () => {
  for (const userId of [...terminals.keys()]) closeTerminalsFor(userId, 'server restarting');
});
