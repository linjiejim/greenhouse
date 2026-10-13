/**
 * The computer's two sockets. Each opens with a one-time ticket in its URL, because a browser
 * cannot put headers on a WebSocket; nothing else ever carries a ticket.
 *
 *   /api/ws/computer?ticket=            the screen, RFB both ways as binary messages. A `view`
 *                                       ticket's keys, clicks and pastes are dropped here
 *                                       (modules/computers/rfb.ts); `control` passes them.
 *   /api/ws/computer-terminal?ticket=   the member's terminal: keystrokes as binary messages, one
 *                                       text message `{"type":"resize","cols","rows"}`, and the
 *                                       output back as binary messages.
 *
 * The streams come from the sandbox (a `docker exec` there), so the computer publishes no port.
 * Per socket: pings every 25 s drop a browser that stopped answering; the computer counts as
 * active while it is open, so the idle stop leaves it alone; the member is checked again every
 * minute; a stop announced by any API process closes it with 4409; a slow browser pauses the
 * stream instead of buffering without bound. Close codes: COMPUTER_SOCKET_CLOSE in the contract.
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { COMPUTER_SOCKET_CLOSE } from '@greenhouse/contract';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { ApiError } from '../http/errors.js';
import { RfbClientFilter } from '../modules/computers/rfb.js';
import type { ComputerSession, ComputersService } from '../modules/computers/service.js';
import { resizeFrame, TERMINAL_FRAME, terminalFrame } from '../modules/computers/terminal.js';
import type { Hub } from './hub.js';
import { originAllowed } from './socket.js';

type SocketKind = 'screen' | 'terminal';

const PATHS: Record<string, SocketKind> = {
  '/api/ws/computer': 'screen',
  '/api/ws/computer-terminal': 'terminal',
};
const PING_MS = 25_000;
const TOUCH_MS = 60_000;
const RECHECK_MS = 60_000;
/** One message at most: a paste, or a clipboard (RFB refuses more than 1 MB of it anyway). */
const MAX_MESSAGE_BYTES = 1024 * 1024 + 64;
/** What a client may send before its stream is open: RFB waits for the server, a terminal sends a resize. */
const MAX_EARLY_BYTES = 64 * 1024;
/** Input the computer has not taken yet; beyond it the client floods rather than types. */
const MAX_UNWRITTEN_BYTES = 8 * 1024 * 1024;
/** Pause the computer's output above this much unsent data; resume below the low mark. */
const HIGH_WATER_BYTES = 4 * 1024 * 1024;
const LOW_WATER_BYTES = 1024 * 1024;
/** After its input ends, a terminal detaches its tmux client (the shell stays) and the screen tunnel ends. */
const HANG_UP_MS = 2_000;

const CLOSE_FOR: Record<string, number> = {
  ticket_invalid: COMPUTER_SOCKET_CLOSE.ticket,
  forbidden: COMPUTER_SOCKET_CLOSE.forbidden,
  computer_not_running: COMPUTER_SOCKET_CLOSE.stopped,
};

const bytesOf = (raw: RawData): Buffer =>
  Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);

export function attachComputerSockets(
  server: Server,
  deps: { computers: ComputersService; hub: Hub; allowedOrigins: string[] },
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  /** Every open socket's cleanup, so a shutdown ends their streams at once. */
  const live = new Set<() => void>();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const kind = PATHS[url.pathname];
    if (!kind) return;
    if (!originAllowed(request, deps.allowedOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const ticket = url.searchParams.get('ticket') ?? '';
    wss.handleUpgrade(request, socket, head, (ws) => connect(ws, kind, ticket));
  };
  server.on('upgrade', onUpgrade);

  function connect(ws: WebSocket, kind: SocketKind, ticket: string) {
    let session: ComputerSession | null = null;
    let filter: RfbClientFilter | null = null;
    let closed = false;
    let alive = true;
    const timers: NodeJS.Timeout[] = [];
    let unsubscribe: (() => void) | null = null;
    const early: Array<{ data: Buffer; text: boolean }> = [];
    let earlyBytes = 0;

    function cleanup() {
      if (closed) return;
      closed = true;
      live.delete(cleanup);
      for (const timer of timers) clearInterval(timer);
      unsubscribe?.();
      if (!session) return;
      const { stream } = session;
      // Keys and buttons still held go up, so nothing stays pressed on the shared display.
      for (const message of filter?.releaseInput() ?? []) stream.input.write(message);
      stream.input.end();
      const kill = setTimeout(() => stream.kill(), HANG_UP_MS);
      kill.unref();
      void stream.exited.then(() => clearTimeout(kill));
    }

    function close(code: number, reason: string) {
      if (closed) return;
      ws.close(code, reason);
      cleanup();
    }

    function handle(open: ComputerSession, data: Buffer, text: boolean) {
      const { input } = open.stream;
      if (kind === 'screen') {
        if (text) return close(1008, 'binary messages only');
        const result = filter!.push(data);
        for (const message of result.forward) input.write(message);
        if (result.close) return close(1008, result.close);
      } else if (text) {
        const frame = resizeFrame(data.toString('utf8'));
        if (!frame) return close(1008, 'unknown message');
        input.write(frame);
      } else if (data.length) {
        input.write(terminalFrame(TERMINAL_FRAME.data, data));
      }
      if (input.writableLength > MAX_UNWRITTEN_BYTES) close(1008, 'too much input');
    }

    /** The computer's output to the browser, paused while the browser falls behind. */
    function pump(open: ComputerSession) {
      const { stream } = open;
      let draining: NodeJS.Timeout | null = null;
      let errors = '';
      stream.output.on('data', (chunk: Buffer) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(chunk, { binary: true });
        if (ws.bufferedAmount > HIGH_WATER_BYTES && !draining) {
          stream.output.pause();
          draining = setInterval(() => {
            if (!closed && ws.bufferedAmount >= LOW_WATER_BYTES) return;
            clearInterval(draining!);
            draining = null;
            if (!closed) stream.output.resume();
          }, 50);
        }
      });
      stream.output.on('error', () => undefined);
      stream.errors.on('data', (chunk: Buffer) => {
        if (errors.length < 2048) errors += chunk.toString('utf8');
      });
      stream.errors.on('error', () => undefined);
      void stream.exited.then((code) => {
        if (closed) return;
        // The computer ended it: the last shell exited, or the display went away (a stop, a restart).
        if (code !== 0) logger.info('[computers] a stream ended', { kind, code, stderr: errors.trim().slice(-300) });
        close(kind === 'terminal' && code === 0 ? 1000 : 1011, `${kind} closed`);
      });
    }

    live.add(cleanup);
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('message', (raw: RawData, isBinary: boolean) => {
      if (closed) return;
      alive = true;
      const data = bytesOf(raw);
      if (!session) {
        earlyBytes += data.length;
        if (earlyBytes > MAX_EARLY_BYTES) return close(1008, 'too much data before the computer was ready');
        early.push({ data, text: !isBinary });
        return;
      }
      handle(session, data, !isBinary);
    });
    ws.on('close', cleanup);
    ws.on('error', () => ws.terminate());

    deps.computers.open(ticket, kind).then(
      (open) => {
        if (closed) {
          open.stream.kill();
          return;
        }
        session = open;
        if (kind === 'screen') filter = new RfbClientFilter(open.purpose === 'control');
        pump(open);
        for (const message of early.splice(0)) {
          if (closed) return;
          handle(open, message.data, message.text);
        }
        timers.push(
          setInterval(() => {
            // terminate(), not close(): a peer that went away never answers a close frame.
            if (!alive) return ws.terminate();
            alive = false;
            ws.ping();
          }, PING_MS),
          setInterval(() => void open.touch().catch(() => undefined), TOUCH_MS),
          setInterval(() => {
            void open
              .allowed()
              .then((ok) => {
                if (!ok) close(COMPUTER_SOCKET_CLOSE.forbidden, 'forbidden');
              })
              .catch(() => undefined);
          }, RECHECK_MS),
        );
        unsubscribe = deps.hub.subscribe(open.memberId, (event) => {
          if (event.type !== 'computer.updated' || event.data.agent_id !== open.agentId) return;
          if (event.data.state !== 'running') close(COMPUTER_SOCKET_CLOSE.stopped, `computer ${event.data.state}`);
        });
      },
      (error: unknown) => {
        if (!(error instanceof ApiError)) {
          logger.warn('[computers] a socket could not open', { kind, error: toErrorMessage(error) });
        }
        const code = error instanceof ApiError ? (CLOSE_FOR[error.code] ?? 1011) : 1011;
        close(code, error instanceof ApiError ? error.code : 'unavailable');
      },
    );
  }

  return {
    async close() {
      server.off('upgrade', onUpgrade);
      for (const client of wss.clients) client.close(1001, 'server stopping');
      for (const cleanup of [...live]) cleanup();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
