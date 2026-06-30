/**
 * WebSocket client — singleton connection to /api/ws with auto-reconnect.
 *
 * Handles:
 * - Token-based auth via query param
 * - Exponential backoff reconnection (1s → 2s → 4s → ... → 30s max)
 * - Automatic ping/pong heartbeat response
 * - Event dispatch to registered handlers
 * - Status change notifications
 *
 * Usage:
 *   import { wsClient } from './ws'
 *   wsClient.connect()
 *   const unsub = wsClient.onEvent((evt) => { ... })
 */

import { getStoredToken, authFetch } from './auth';
import { apiWebSocketUrl } from './api-base';
import type { ServerWsEvent, ClientWsEvent } from '@greenhouse/types/ws';

export type WsStatus = 'disconnected' | 'connecting' | 'connected';
export type WsEventHandler = (event: ServerWsEvent) => void;
export type WsStatusListener = (status: WsStatus) => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30_000;
  private intentionalClose = false;
  private handlers = new Set<WsEventHandler>();
  private statusListeners = new Set<WsStatusListener>();
  private _status: WsStatus = 'disconnected';

  /** Current connection status. */
  get status(): WsStatus {
    return this._status;
  }

  /** Establish WebSocket connection. No-op if already connected/connecting. */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    const token = getStoredToken();
    if (!token) return;

    this.intentionalClose = false;
    this.setStatus('connecting');

    this.ws = new WebSocket(apiWebSocketUrl(`/api/ws?token=${encodeURIComponent(token)}`));

    this.ws.onopen = () => {
      this.reconnectDelay = 1000; // Reset backoff on successful connect
      this.setStatus('connected');
    };

    this.ws.onmessage = (evt: MessageEvent) => {
      try {
        const event = JSON.parse(evt.data) as ServerWsEvent;

        // Auto-reply to server ping
        if (event.type === 'ping') {
          this.send({ type: 'pong' });
          return;
        }

        // Dispatch to all handlers
        for (const handler of this.handlers) {
          handler(event);
        }
      } catch {
        /* ignore malformed messages */
      }
    };

    this.ws.onclose = (evt: CloseEvent) => {
      this.ws = null;
      this.setStatus('disconnected');

      if (this.intentionalClose) return;

      // If server closed with 4002 (token expired), try refreshing first
      if (evt.code === 4002) {
        this.refreshAndReconnect();
      } else {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose fires immediately after onerror — no extra handling needed
    };
  }

  /** Intentionally close the connection (e.g. on logout). */
  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  /** Register an event handler. Returns an unsubscribe function. */
  onEvent(handler: WsEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Register a status change listener. Returns an unsubscribe function. */
  onStatusChange(listener: WsStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ─── Private ────────────────────────────────────────────

  private send(event: ClientWsEvent): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    // Exponential backoff with jitter
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Trigger a token refresh via authFetch, then reconnect. */
  private refreshAndReconnect(): void {
    // authFetch to any authenticated endpoint triggers the refresh logic
    authFetch('/api/auth/me')
      .then(() => {
        // Token refreshed — reconnect immediately
        this.reconnectDelay = 1000;
        this.connect();
      })
      .catch(() => {
        // Refresh failed — schedule normal reconnect (will likely fail too)
        this.scheduleReconnect();
      });
  }

  private setStatus(status: WsStatus): void {
    if (this._status === status) return;
    this._status = status;
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}

/** Singleton WebSocket client instance. */
export const wsClient = new WebSocketClient();
