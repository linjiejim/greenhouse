/**
 * Routes the realtime pushes into the Bots store (spec
 * docs/specs/20261008-mobile-bots.md §2.7.2 "同步规则", D13). The pushes only
 * say "X changed"; the store re-reads over REST. The open thread listens to the
 * same pushes itself (./thread/engine.ts) — this is the app-wide part: the
 * drawer rows, the ☰ badge, the pending cards, busy marks.
 *
 * | push                          | store                                                  |
 * |-------------------------------|--------------------------------------------------------|
 * | `resync` (connected)          | Bots + conversations + pending + busy seed (`seedRuns`) |
 * | `chat:run running`            | busy mark; a known Bots conversation → list reload       |
 * | `chat:run completed / error`  | busy mark cleared; a known Bots conversation → list reload |
 * | `bots:conversation`           | list reload                                            |
 * | `bots:attention {pending}`    | the count at once + pending list reload                |
 * | poll (socket down, foreground) | conversations + pending + busy seed                    |
 * List / pending reloads are debounced (400 ms): a burst of pushes is one read.
 *
 * Polling fallback (socket down ≥ 10 s, foreground): lists and the busy seed
 * every 30 s, so the badge, the pending cards and "Replying…" still move
 * without a socket (a run's end pushed while it was down is never heard).
 *
 * Started by <RealtimeBridge/> (src/realtime/realtime-bridge.tsx) only while
 * Bots are available; everything injected for the root vitest (./sync.test.ts).
 */

import type { Realtime, RealtimeEvent, ThreadDeps } from './contract';
import type { BotsState } from './store-core';
import { createFallbackPoller } from './thread/polling';

/** A burst of pushes (one per Bot turn) collapses into one list read. */
export const LIST_RELOAD_MS = 400;
/** Lists polled this often while the socket is down (foreground). */
export const LIST_POLL_MS = 30_000;

export interface BotsSyncDeps {
  realtime: Realtime;
  store: { getState(): BotsState };
  clock: ThreadDeps['clock'];
}

export interface BotsSync {
  /** The app is in the foreground (the polling fallback only runs then). */
  setForeground(active: boolean): void;
  dispose(): void;
}

export function startBotsSync(deps: BotsSyncDeps): BotsSync {
  const { realtime, store, clock } = deps;
  let disposed = false;
  let listTimer: unknown = null;
  let pendingTimer: unknown = null;

  const debounced = (current: unknown, run: () => void): unknown => {
    if (current !== null) clock.clearTimeout(current);
    return clock.setTimeout(run, LIST_RELOAD_MS);
  };
  const reloadListSoon = () => {
    listTimer = debounced(listTimer, () => {
      listTimer = null;
      if (!disposed) void store.getState().loadConversations();
    });
  };
  const reloadPendingSoon = () => {
    pendingTimer = debounced(pendingTimer, () => {
      pendingTimer = null;
      if (!disposed) void store.getState().loadPending();
    });
  };
  const resync = () => {
    const state = store.getState();
    void state.loadBots();
    void state.loadConversations();
    void state.loadPending();
    void state.seedRuns();
  };
  const knownConversation = (sessionId: string) =>
    store.getState().conversations.some((row) => row.session_id === sessionId);

  const onEvent = (e: RealtimeEvent) => {
    if (disposed) return;
    const state = store.getState();
    switch (e.type) {
      case 'resync':
        resync();
        return;
      case 'chat:run':
        if (e.status === 'running') {
          state.setRunning(e.sessionId, e.runId);
        } else {
          // Only this run's mark: a newer run of the session may already be announced.
          const current = state.running[e.sessionId];
          if (current === undefined || current === e.runId) state.setRunning(e.sessionId, null);
        }
        // "Replying…" and the preview follow; chat:run is pushed for plain conversations too.
        if (knownConversation(e.sessionId)) reloadListSoon();
        return;
      case 'bots:conversation':
        reloadListSoon();
        return;
      case 'bots:attention':
        state.setPendingTotal(e.pending);
        reloadPendingSoon();
        return;
      default:
        return;
    }
  };

  const unsubscribeEvents = realtime.on(onEvent);
  const poller = createFallbackPoller({
    realtime,
    clock,
    intervalMs: LIST_POLL_MS,
    tick: () => {
      const state = store.getState();
      void state.loadConversations();
      void state.loadPending();
      // No socket, no `chat:run` pushes: the busy marks come from the seed alone.
      void state.seedRuns();
    },
  });

  // Already connected (Bots turned on mid-session): no `connected` frame will come — read now.
  if (realtime.status === 'open') resync();

  return {
    setForeground(active) {
      poller.setActive(active);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (listTimer !== null) clock.clearTimeout(listTimer);
      if (pendingTimer !== null) clock.clearTimeout(pendingTimer);
      poller.dispose();
      unsubscribeEvents();
    },
  };
}
