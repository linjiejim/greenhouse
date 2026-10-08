/**
 * WebSocket route — /api/ws
 *
 * Handles WebSocket upgrade with token-based authentication.
 * Uses @hono/node-server's built-in upgradeWebSocket + ws library.
 *
 * Auth: query param ?token=<access_token> validated via validateAccessToken().
 * Only active internal users (super/team) can connect.
 *
 * Lifecycle:
 *   onOpen  → register in ConnectionManager, push initial state
 *   onMessage → handle client pong heartbeat
 *   onClose → remove from ConnectionManager
 *
 * @hono/node-server calls these without awaiting them, so a rejected onOpen is
 * an unhandled rejection and Node exits the whole API. onOpen therefore never
 * throws: a failed account lookup (a transient DB error such as a postgres
 * CONNECT_TIMEOUT) closes the socket with 1011, which every client treats as
 * retryable (reconnect with backoff). 4001/4002/4003 stay reserved for auth /
 * terminal outcomes.
 */

import { Hono } from 'hono';
import { upgradeWebSocket } from '@hono/node-server';
import { validateAccessToken } from '../auth/token.js';
import { getDb, type UserRow } from '@greenhouse/db';
import { connectionManager } from './connection-manager.js';
import { nowIso } from '@greenhouse/utils/date';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { ServerWsEvent, ClientWsEvent } from '@greenhouse/types/ws';
import type { WSContext } from 'hono/ws';

const wsApp = new Hono();

wsApp.get(
  '/',
  upgradeWebSocket((c) => {
    // Extract token from query param for auth
    const url = new URL(c.req.url);
    const token = url.searchParams.get('token');

    const payload = token ? validateAccessToken(token) : null;
    if (!payload || (payload.role !== 'super' && payload.role !== 'team')) {
      return {
        onOpen(_evt: Event, ws: WSContext) {
          ws.close(4001, 'Unauthorized');
        },
      };
    }

    const userId = payload.uid;
    let role: string = payload.role;
    const tokenAuthVersion = payload.authVersion;
    const tokenExp = payload.exp;
    let conn: {
      ws: WSContext;
      userId: string;
      nickname: string;
      role: string;
      connectedAt: string;
      tokenAuthVersion: number;
      tokenExp: number;
    } | null = null;
    // Set by onClose/onError: a socket that went away while onOpen awaited the
    // account lookup must not be registered afterwards (it would linger in the
    // presence list and count against the per-user cap).
    let gone = false;

    return {
      async onOpen(_evt: Event, ws: WSContext) {
        // Re-resolve the account so disabled, deleted, or demoted users cannot
        // keep a WebSocket alive with a previously issued token.
        let user: UserRow | undefined;
        try {
          user = await getDb().users.getById(userId);
        } catch (error) {
          logger.warn(`[WS] Account lookup failed for ${userId}; closing with 1011 (client retries)`, {
            error: toErrorMessage(error),
          });
          closeQuietly(ws, 1011, 'Account validation failed');
          return;
        }
        if (gone) return;
        if (
          !user ||
          user.status !== 'active' ||
          user.auth_version !== tokenAuthVersion ||
          (user.role !== 'super' && user.role !== 'team')
        ) {
          closeQuietly(ws, 4001, 'Unauthorized');
          return;
        }
        role = user.role;
        const nickname = user.nickname || 'Unknown';
        conn = { ws, userId, nickname, role, connectedAt: nowIso(), tokenAuthVersion, tokenExp };
        connectionManager.add(conn);

        // Send connection confirmation
        send(ws, { type: 'connected', userId });

        // Push current unread share count
        try {
          const shareCount = await getDb().sessionShares.countUnread(userId);
          send(ws, { type: 'share:count', count: shareCount });
        } catch {
          /* ignore */
        }

        // Platform notifications use an independent permanent read model; a
        // reconnect always refreshes the badge even if a live push was missed.
        try {
          const unread = await getDb().notifications.countUnread(userId);
          send(ws, { type: 'notification:summary', unread });
        } catch {
          /* keep the socket useful when the notification projection is degraded */
        }

        // If super, push current online users snapshot
        if (role === 'super') {
          const onlineUsers = connectionManager.getOnlineUsers();
          send(ws, { type: 'presence:snapshot', users: onlineUsers });
        }
      },

      onMessage(evt: MessageEvent) {
        try {
          const raw = typeof evt.data === 'string' ? evt.data : '';
          const msg = JSON.parse(raw) as ClientWsEvent;
          if (msg.type === 'pong') {
            // Heartbeat response — connection is alive
          }
        } catch {
          // Ignore malformed messages
        }
      },

      onClose() {
        gone = true;
        if (conn) connectionManager.remove(conn);
        conn = null;
      },

      onError() {
        gone = true;
        logger.warn(`[WS] Error for user ${userId}`);
        if (conn) connectionManager.remove(conn);
        conn = null;
      },
    };
  }),
);

/** Close without throwing (the peer may already be gone). */
function closeQuietly(ws: WSContext, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already closed */
  }
}

/** Helper to send a typed event to a WSContext. */
function send(ws: WSContext, event: ServerWsEvent): void {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    /* ignore send errors on closed sockets */
  }
}

export default wsApp;
