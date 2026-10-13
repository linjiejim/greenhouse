/**
 * The one WebSocket, /api/ws. A client opens it, sends `{ type: 'hello', data: { token } }`
 * within five seconds, and then receives every event for that member. Browsers cannot set
 * headers on a WebSocket, so the token travels in the first frame, never in the URL.
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { helloSchema } from '@greenhouse/contract';
import { logger } from '@greenhouse/utils/logger';
import { authenticate } from '../auth/middleware.js';
import type { Tokens } from '../auth/tokens.js';
import type { Hub } from './hub.js';

const HELLO_TIMEOUT_MS = 5_000;
const PING_MS = 25_000;
/** Disabling a member or changing a password ends their sockets within this long. */
const RECHECK_MS = 60_000;

/** Close codes clients can act on: 4401 = sign in again. */
export const CLOSE_UNAUTHORIZED = 4401;

export function attachRealtime(server: Server, deps: { hub: Hub; tokens: Tokens; allowedOrigins: string[] }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  function originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    // Native clients send no Origin; a browser page must be one we serve or allow.
    if (!origin) return true;
    const host = request.headers.host;
    try {
      if (host && new URL(origin).host === host) return true;
    } catch {
      return false;
    }
    return deps.allowedOrigins.includes(origin);
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== '/api/ws') return;
    if (!originAllowed(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => connect(ws));
  };
  server.on('upgrade', onUpgrade);

  function connect(ws: WebSocket) {
    let unsubscribe: (() => void) | null = null;
    let token: string | null = null;
    let alive = true;
    const hello = setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, 'hello expected'), HELLO_TIMEOUT_MS);
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, PING_MS);
    const recheck = setInterval(() => {
      if (!token) return;
      void authenticate(deps.tokens, token).then((member) => {
        if (!member) ws.close(CLOSE_UNAUTHORIZED, 'sign in again');
      });
    }, RECHECK_MS);
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('message', (raw) => {
      if (unsubscribe) return; // Clients only ever send hello; everything else goes through POST.
      let parsed: ReturnType<typeof helloSchema.safeParse>;
      try {
        parsed = helloSchema.safeParse(JSON.parse(String(raw)));
      } catch {
        return ws.close(CLOSE_UNAUTHORIZED, 'hello expected');
      }
      if (!parsed.success) return ws.close(CLOSE_UNAUTHORIZED, 'hello expected');
      void authenticate(deps.tokens, parsed.data.data.token)
        .then((member) => {
          if (!member) return ws.close(CLOSE_UNAUTHORIZED, 'sign in again');
          if (ws.readyState !== ws.OPEN) return;
          clearTimeout(hello);
          token = parsed.data!.data.token;
          unsubscribe = deps.hub.subscribe(member.id, (event) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
          });
          ws.send(JSON.stringify({ type: 'ready', data: { member_id: member.id } }));
        })
        .catch((error: unknown) => {
          logger.warn('[realtime] hello failed', { error: String(error) });
          ws.close(1011, 'try again');
        });
    });
    ws.on('close', () => {
      clearTimeout(hello);
      clearInterval(ping);
      clearInterval(recheck);
      unsubscribe?.();
    });
    ws.on('error', () => ws.terminate());
  }

  return {
    async close() {
      server.off('upgrade', onUpgrade);
      for (const client of wss.clients) client.close(1001, 'server stopping');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
