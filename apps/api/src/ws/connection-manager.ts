/**
 * WebSocket Connection Manager — tracks online users and routes messages.
 *
 * Maintains a Map<userId, Set<Connection>> to support multiple tabs/devices
 * per user. Provides helpers to send to individual users, broadcast to all,
 * or broadcast to super-admin users only (for presence events).
 *
 * Singleton: import { connectionManager } from './connection-manager.js'
 */

import type { WSContext } from 'hono/ws';
import type { OnlineUser, ServerWsEvent } from '@greenhouse/types/ws';
import { logger } from '@greenhouse/utils/logger';

interface Connection {
  ws: WSContext;
  userId: string;
  nickname: string;
  role: string;
  connectedAt: string;
  /** Token expiry timestamp in seconds (0 = dev mode, no expiry). */
  tokenExp: number;
}

class ConnectionManager {
  /** userId → Set<Connection> (one user may have multiple tabs/devices) */
  private connections = new Map<string, Set<Connection>>();

  /** Max connections allowed per user. */
  private readonly maxPerUser = 10;

  /** Register a new WebSocket connection. */
  add(conn: Connection): void {
    let set = this.connections.get(conn.userId);
    if (!set) {
      set = new Set();
      this.connections.set(conn.userId, set);
    }
    const isNewUser = set.size === 0;
    set.add(conn);
    logger.info(`[WS] + ${conn.nickname} (${conn.userId}) connected — ${set.size} session(s)`);

    // Enforce per-user connection limit
    if (set.size > this.maxPerUser) {
      const oldest = set.values().next().value;
      if (oldest && oldest !== conn) {
        logger.info(`[WS] Connection limit (${this.maxPerUser}) exceeded for ${conn.nickname}, closing oldest`);
        set.delete(oldest);
        try {
          oldest.ws.close(4003, 'Too many connections');
        } catch {
          /* ignore */
        }
      }
    }

    if (isNewUser) {
      // Broadcast presence:join to all super users
      this.broadcastToSuper({
        type: 'presence:join',
        user: {
          userId: conn.userId,
          nickname: conn.nickname,
          role: conn.role,
          connectedAt: conn.connectedAt,
        },
      });
    }
  }

  /** Remove a WebSocket connection. */
  remove(conn: Connection): void {
    const set = this.connections.get(conn.userId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) {
      this.connections.delete(conn.userId);
      logger.info(`[WS] - ${conn.nickname} (${conn.userId}) fully disconnected`);
      // Broadcast presence:leave to all super users
      this.broadcastToSuper({ type: 'presence:leave', userId: conn.userId });
    } else {
      logger.info(`[WS] - ${conn.nickname} (${conn.userId}) tab closed — ${set.size} remaining`);
    }
  }

  /** Get deduplicated list of online users. */
  getOnlineUsers(): OnlineUser[] {
    const users: OnlineUser[] = [];
    for (const [userId, set] of this.connections) {
      const first = set.values().next().value;
      if (first) {
        users.push({
          userId,
          nickname: first.nickname,
          role: first.role,
          connectedAt: first.connectedAt,
        });
      }
    }
    return users;
  }

  /** Get count of online users (deduplicated). */
  getOnlineCount(): number {
    return this.connections.size;
  }

  /** Check if a specific user is online. */
  isOnline(userId: string): boolean {
    return this.connections.has(userId);
  }

  /** Send an event to all connections of a specific user. */
  sendToUser(userId: string, event: ServerWsEvent): void {
    const set = this.connections.get(userId);
    if (!set) return;
    const data = JSON.stringify(event);
    for (const conn of set) {
      try {
        conn.ws.send(data);
      } catch {
        /* broken connections are cleaned up in onClose */
      }
    }
  }

  /** Broadcast an event to ALL connected users. */
  broadcast(event: ServerWsEvent): void {
    const data = JSON.stringify(event);
    for (const set of this.connections.values()) {
      for (const conn of set) {
        try {
          conn.ws.send(data);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Broadcast an event to super-admin users only. */
  broadcastToSuper(event: ServerWsEvent): void {
    const data = JSON.stringify(event);
    for (const set of this.connections.values()) {
      for (const conn of set) {
        if (conn.role === 'super') {
          try {
            conn.ws.send(data);
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  /** Send ping to all connections; close any with expired tokens. */
  pingAll(): void {
    const now = Math.floor(Date.now() / 1000);
    const data = JSON.stringify({ type: 'ping' } as ServerWsEvent);
    for (const set of this.connections.values()) {
      for (const conn of set) {
        // Check token expiry (0 = dev mode, skip)
        if (conn.tokenExp > 0 && conn.tokenExp < now) {
          logger.info(`[WS] Token expired for ${conn.nickname} (${conn.userId}), closing`);
          try {
            conn.ws.close(4002, 'Token expired');
          } catch {
            /* ignore */
          }
          continue;
        }
        try {
          conn.ws.send(data);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

// Singleton
export const connectionManager = new ConnectionManager();
