/**
 * WebSocket Store (Zustand) — real-time connection state + push data.
 *
 * Bridges wsClient events into reactive Zustand state consumed by components:
 * - shareCount: unread share count (replaces old mentionCount)
 * - onlineUsers: online internal users (super-only, for presence indicator)
 * - status: WebSocket connection status
 *
 * Connection lifecycle is tied to auth state — see useWsLifecycle() hook.
 */

import { create } from 'zustand';
import { wsClient, type WsStatus } from '../lib/ws';
import type { OnlineUser, ServerWsEvent } from '@greenhouse/types/ws';
import { toast } from '../components/ui';
import { useUIStore } from './ui-store';
import { notifyRuntimeInvalidated } from '../lib/runtime-invalidation';

interface WsStore {
  status: WsStatus;
  shareCount: number;
  notificationCount: number;
  onlineUsers: OnlineUser[];

  // Actions
  connect: () => void;
  disconnect: () => void;
}

export const useWsStore = create<WsStore>((set) => {
  // Subscribe to connection status changes
  wsClient.onStatusChange((status) => {
    set({ status });
    if (status === 'connected') notifyRuntimeInvalidated();
    // Clear presence data on disconnect (will be re-pushed on reconnect)
    if (status === 'disconnected') {
      set({ onlineUsers: [] });
    }
  });

  // Subscribe to server events
  wsClient.onEvent((event: ServerWsEvent) => {
    switch (event.type) {
      case 'share:count':
        set({ shareCount: event.count });
        break;

      case 'notification:summary':
        set({ notificationCount: event.unread });
        break;

      case 'notification:new':
        set({ notificationCount: event.unread });
        toast(event.title, 'info');
        break;

      case 'share:new':
        // Show toast notification for new shares
        toast(`${event.sharedByNickname} shared "${event.sessionTitle}" with you`, 'info');
        break;

      case 'presence:snapshot':
        set({ onlineUsers: event.users });
        break;

      case 'presence:join':
        set((s) => ({
          onlineUsers: s.onlineUsers.some((u) => u.userId === event.user.userId)
            ? s.onlineUsers
            : [...s.onlineUsers, event.user],
        }));
        break;

      case 'presence:leave':
        set((s) => ({
          onlineUsers: s.onlineUsers.filter((u) => u.userId !== event.userId),
        }));
        break;

      case 'session:created':
        // A child session was spawned server-side — refresh the history sidebar.
        useUIStore.getState().bumpSessionListVersion();
        break;

      case 'runtime:invalidate':
        notifyRuntimeInvalidated(event.runId);
        break;
    }
  });

  return {
    status: 'disconnected',
    shareCount: 0,
    notificationCount: 0,
    onlineUsers: [],

    connect: () => wsClient.connect(),
    disconnect: () => wsClient.disconnect(),
  };
});
