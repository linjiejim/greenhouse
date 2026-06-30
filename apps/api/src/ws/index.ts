/**
 * WebSocket route — /api/ws
 *
 * Handles WebSocket upgrade with token-based authentication.
 * Uses @hono/node-server's built-in upgradeWebSocket + ws library.
 *
 * Auth: query param ?token=<access_token> validated via validateAccessToken().
 * Only internal users (super/admin/member) can connect; external is rejected.
 *
 * Lifecycle:
 *   onOpen  → register in ConnectionManager, push initial state
 *   onMessage → handle client pong heartbeat
 *   onClose → remove from ConnectionManager
 */

import { Hono } from 'hono';
import { upgradeWebSocket } from '@hono/node-server';
import { validateAccessToken, isAuthEnabled } from '../auth/token.js';
import { getDb } from '@greenhouse/db';
import { connectionManager } from './connection-manager.js';
import { nowIso } from '@greenhouse/utils/date';
import { logger } from '@greenhouse/utils/logger';
import type { ServerWsEvent, ClientWsEvent } from '@greenhouse/types/ws';
import type { WSContext } from 'hono/ws';

const wsApp = new Hono();

wsApp.get(
  '/',
  upgradeWebSocket((c) => {
    // Extract token from query param for auth
    const url = new URL(c.req.url);
    const token = url.searchParams.get('token');

    // In dev mode (no ACCESS_PASSWORD), allow all connections as dev user
    let userId: string;
    let role: string;
    let tokenExp = 0; // 0 = dev mode, no expiry

    if (!isAuthEnabled()) {
      userId = 'dev';
      role = 'super';
    } else {
      const payload = token ? validateAccessToken(token) : null;

      // Reject unauthenticated or external users
      if (!payload || payload.role === 'external') {
        return {
          onOpen(_evt: Event, ws: WSContext) {
            ws.close(4001, 'Unauthorized');
          },
        };
      }

      userId = payload.uid;
      role = payload.role;
      tokenExp = payload.exp;
    }
    let conn: {
      ws: WSContext;
      userId: string;
      nickname: string;
      role: string;
      connectedAt: string;
      tokenExp: number;
    } | null = null;

    return {
      async onOpen(_evt: Event, ws: WSContext) {
        // Look up user nickname
        const user = await getDb().users.getById(userId);
        const nickname = user?.nickname || 'Unknown';
        conn = { ws, userId, nickname, role, connectedAt: nowIso(), tokenExp };
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
        if (conn) connectionManager.remove(conn);
        conn = null;
      },

      onError() {
        logger.warn(`[WS] Error for user ${userId}`);
        if (conn) connectionManager.remove(conn);
        conn = null;
      },
    };
  }),
);

/** Helper to send a typed event to a WSContext. */
function send(ws: WSContext, event: ServerWsEvent): void {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    /* ignore send errors on closed sockets */
  }
}

export default wsApp;
