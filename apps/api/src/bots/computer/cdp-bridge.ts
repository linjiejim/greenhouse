/**
 * The API-side DevTools endpoint Playwright connects to (spec §6.1, review R2).
 *
 * Playwright's connectOverCDP speaks WebSocket; the computer exposes the
 * DevTools PIPE protocol (NUL-terminated JSON) on a 0600 Unix socket that only
 * `docker exec -u browser` reaches. This bridge sits between them, in process:
 *
 *   Playwright ─ws://127.0.0.1:<port>/<128-bit secret>/devtools/browser─▶ bridge
 *     ─stdin/stdout─▶ docker exec -i -u browser <c> socat STDIO UNIX-CONNECT:/tmp/browser/cdp.sock
 *
 * The listener binds loopback only, on a random port, and the API host may run
 * other stacks (letpot-dev runs several PM2 apps): so the upgrade must present
 * the secret path, compared in constant time, BEFORE anything is spawned —
 * every other request (`/json/version`, a wrong path, a second client) is
 * refused without ever touching docker. One connection per bridge; when it
 * closes, the tunnel is killed and the bridge shuts itself down.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import * as wsModule from 'ws';
import { logger } from '@greenhouse/utils/logger';

// ws is CJS; the namespace import works under both tsx and the compiled build (see index.ts).
const WebSocketServerCtor = (wsModule.WebSocketServer ??
  (wsModule as unknown as { default: typeof wsModule }).default.WebSocketServer) as typeof wsModule.WebSocketServer;
type WsSocket = wsModule.WebSocket;

/** Largest single DevTools message accepted from Playwright (file uploads ride on CDP). */
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

export interface CdpBridge {
  /** The endpoint for `chromium.connectOverCDP(url, { noDefaults: true })`. */
  url: string;
  close(): Promise<void>;
}

export interface CdpBridgeOptions {
  /** Start the tunnel into the computer (only called for an authenticated upgrade). */
  spawnTunnel(): ChildProcess;
  /** The connection ended (either side); the bridge is already closing. */
  onClose?(): void;
  /** Override the random secret (tests). */
  secret?: string;
}

function samePath(actual: string | undefined, expected: string): boolean {
  const a = Buffer.from(actual ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function openCdpBridge(options: CdpBridgeOptions): Promise<CdpBridge> {
  const secret = options.secret ?? randomBytes(16).toString('hex');
  const path = `/${secret}/devtools/browser`;
  let active: { ws: WsSocket; child: ChildProcess } | null = null;
  let used = false;
  let closed = false;

  // Plain HTTP (DevTools discovery, probes) gets nothing.
  const server: Server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServerCtor({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

  const shutdown = async () => {
    if (closed) return;
    closed = true;
    if (active) {
      active.child.kill('SIGKILL');
      active.ws.terminate();
      active = null;
    }
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    options.onClose?.();
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closed || used || !samePath(req.url, path)) {
      socket.destroy();
      return;
    }
    used = true;
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
  });

  function attach(ws: WsSocket): void {
    let child: ChildProcess;
    try {
      child = options.spawnTunnel();
    } catch (err) {
      logger.warn(`[bots-computer] DevTools tunnel failed to start: ${String(err)}`);
      ws.close(1011, 'tunnel failed');
      void shutdown();
      return;
    }
    active = { ws, child };
    let pending: Buffer = Buffer.alloc(0);

    child.stdout!.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      for (let end = pending.indexOf(0, start); end >= 0; end = pending.indexOf(0, start)) {
        if (end > start && ws.readyState === ws.OPEN) ws.send(pending.subarray(start, end).toString('utf8'));
        start = end + 1;
      }
      pending = start ? pending.subarray(start) : pending;
    });
    child.stderr!.on('data', () => {});
    child.on('error', () => void shutdown());
    child.on('exit', () => {
      if (ws.readyState === ws.OPEN) ws.close(1011, 'computer tunnel closed');
      void shutdown();
    });
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const payload = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      // A NUL inside a message would split it in two on the other side.
      if (payload.includes(0)) return;
      child.stdin!.write(Buffer.concat([payload, Buffer.from([0])]));
    });
    ws.on('close', () => void shutdown());
    ws.on('error', () => void shutdown());
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `ws://127.0.0.1:${port}${path}`, close: shutdown };
}
