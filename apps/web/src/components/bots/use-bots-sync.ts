/**
 * Shell-level Bots sync: keeps the "needs you" count and the conversation
 * list fresh for the whole app, not just the Bots page — a
 * member who delegated and walked off to Projects still sees the Bots nav
 * badge and the `(1)` in the tab title when a Bot is stuck waiting for them.
 *
 * WS carries ids and counts only (`bots:attention`, `bots:conversation`);
 * content is always re-read over REST.
 */

import { useEffect } from 'react';
import { wsClient } from '../../lib/ws';
import { getRuntimeProductName } from '../../lib/workspace-branding';
import { useBotsStore } from './bots-store';

/** Collapse a burst of `bots:conversation` events (one per Bot turn) into one list fetch. */
const LIST_REFRESH_DEBOUNCE_MS = 400;

export function useBotsSync(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      useBotsStore.getState().reset();
      return;
    }
    const store = useBotsStore.getState();
    // Both lists, on every page: conversation rows name their Bots, so a list
    // cached without its Bots would read "Deleted Bot" until the Bots page
    // happened to fetch them. A failure is kept in the store (`loadError`)
    // for the surfaces that show it with a retry.
    void store.loadBots().catch(() => {});
    void store.loadConversations().catch(() => {});

    let timer: ReturnType<typeof setTimeout> | null = null;
    const refreshSoon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void useBotsStore
          .getState()
          .loadConversations()
          .catch(() => {});
      }, LIST_REFRESH_DEBOUNCE_MS);
    };

    const unsubscribeEvents = wsClient.onEvent((event) => {
      const state = useBotsStore.getState();
      if (event.type === 'bots:attention') {
        state.setPending(event.pending);
        refreshSoon();
      } else if (event.type === 'bots:conversation') {
        state.noteSession(event.sessionId);
        refreshSoon();
      } else if (event.type === 'chat:run' && state.knownSessionIds.has(event.sessionId)) {
        // A Bots run started or ended: the list's "working" dot and preview follow.
        refreshSoon();
      }
    });
    // A reconnect may have missed pushes — re-read instead of trusting the
    // cache. It is also the retry for a Bot list that failed to load while
    // the network was down.
    const unsubscribeStatus = wsClient.onStatusChange((status) => {
      if (status !== 'connected') return;
      void useBotsStore
        .getState()
        .loadBots()
        .catch(() => {});
      refreshSoon();
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribeEvents();
      unsubscribeStatus();
    };
  }, [enabled]);

  const pending = useBotsStore((state) => state.pending);
  useEffect(() => {
    // The tab title is how a backgrounded tab says "a Bot is waiting on you".
    const product = getRuntimeProductName();
    document.title = enabled && pending > 0 ? `(${pending > 99 ? '99+' : pending}) ${product}` : product;
  }, [enabled, pending]);
}
