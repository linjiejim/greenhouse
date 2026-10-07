/**
 * Routes the realtime pushes into the Bots store (spec
 * docs/specs/20261008-mobile-bots.md §2.7.2 "同步规则", D13). The pushes only
 * say "X changed"; the store re-reads over REST. The open thread listens to the
 * same pushes itself (./thread/engine.ts) — this is the app-wide part: the
 * drawer rows, the ☰ badge, the "needs you" capsule, busy marks.
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
 * Report arrivals (the capsule's "Fern handed back '…'"): a background task's
 * report starts no run (06 C3) — it only shows as a changed conversation. So
 * every time the list changes, a row is looked at closer — one
 * `GET …/conversations/:id?limit=1`, one at a time — only when it is not the
 * thread on screen, became unread or got a new last message, has no run going,
 * the last message is not the member's own, and that last message was not
 * looked at before. If its last row is a `task_report`, the store notes the
 * arrival. A server that sends `last_message.event_kind` (optional server
 * change S2) answers "not a report" without any request.
 *
 * A row skipped only because it had a busy mark is remembered and looked at on
 * the next list after the mark goes (a stale mark — its run's end was missed —
 * must not swallow a report that landed meanwhile).
 *
 * Polling fallback (socket down ≥ 10 s, foreground): lists and the busy seed
 * every 30 s, so the badge, the capsule and "Replying…" still move without a
 * socket (a run's end pushed while it was down is never heard).
 *
 * Started by <RealtimeBridge/> (src/realtime/realtime-bridge.tsx) only while
 * Bots are available; everything injected for the root vitest (./sync.test.ts).
 */

import type { BotConversationSummary } from '../shared/bots';
import type { Realtime, RealtimeEvent, ThreadDeps } from './contract';
import type { BotsState } from './store-core';
import { createFallbackPoller } from './thread/polling';

/** A burst of pushes (one per Bot turn) collapses into one list read. */
export const LIST_RELOAD_MS = 400;
/** Lists polled this often while the socket is down (foreground). */
export const LIST_POLL_MS = 30_000;

export interface BotsSyncDeps {
  realtime: Realtime;
  store: {
    getState(): BotsState;
    subscribe(listener: (state: BotsState, previous: BotsState) => void): () => void;
  };
  api: Pick<typeof import('../api/bots'), 'getConversation'>;
  clock: ThreadDeps['clock'];
}

export interface BotsSync {
  /** The app is in the foreground (the polling fallback only runs then). */
  setForeground(active: boolean): void;
  dispose(): void;
}

export function startBotsSync(deps: BotsSyncDeps): BotsSync {
  const { realtime, store, api, clock } = deps;
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

  // ─── Report arrivals ────────────────────────────────────

  /** `sessionId \n created_at` of last messages already looked at (this store generation). */
  const checked = new Set<string>();
  /** Rows that changed while they had a busy mark: looked at once the mark goes, changed again or not. */
  const skippedBusy = new Set<string>();
  const queue: Array<{ sessionId: string; generation: number }> = [];
  let inFlight = false;

  const lookAt = (previous: readonly BotConversationSummary[], next: readonly BotConversationSummary[]) => {
    const state = store.getState();
    const before = new Map(previous.map((row) => [row.session_id, row]));
    for (const row of next) {
      const last = row.last_message;
      if (row.session_id === state.visibleThread) {
        // On screen: whatever landed is seen there.
        skippedBusy.delete(row.session_id);
        continue;
      }
      if (!last) continue;
      const old = before.get(row.session_id);
      const changed =
        !old ||
        (row.attention === 'unread' && old.attention !== 'unread') ||
        old.last_message?.created_at !== last.created_at ||
        skippedBusy.has(row.session_id);
      if (!changed) continue;
      if (state.running[row.session_id] !== undefined) {
        skippedBusy.add(row.session_id);
        continue;
      }
      skippedBusy.delete(row.session_id);
      if (last.role === 'user') continue;
      const key = `${row.session_id}\n${last.created_at}`;
      if (checked.has(key)) continue;
      checked.add(key);
      // Optional server field (S2): the last row's event kind, when the server sends it.
      const kind = (last as { event_kind?: unknown }).event_kind;
      if (kind !== undefined && kind !== 'task_report') continue;
      if (!queue.some((item) => item.sessionId === row.session_id)) {
        queue.push({ sessionId: row.session_id, generation: state.generation });
      }
    }
    void drain();
  };

  const drain = async () => {
    if (inFlight || disposed) return;
    const item = queue.shift();
    if (!item) return;
    inFlight = true;
    try {
      const page = await api.getConversation(item.sessionId, { limit: 1 });
      const state = store.getState();
      if (disposed || state.generation !== item.generation || !page.ok) return;
      // Opened meanwhile: it is on screen, nothing to call back.
      if (state.visibleThread === item.sessionId) return;
      const lastRow = page.value.messages[page.value.messages.length - 1];
      const event = lastRow?.bot_event;
      if (event?.kind !== 'task_report') return;
      state.noteArrival(item.sessionId, {
        botId: event.bot_id,
        title: event.title,
        status: event.status,
        at: clock.now(),
      });
    } finally {
      inFlight = false;
      void drain();
    }
  };

  const unsubscribeStore = store.subscribe((state, previous) => {
    if (disposed) return;
    if (state.generation !== previous.generation) {
      // Another account / station: nothing from before applies.
      checked.clear();
      skippedBusy.clear();
      queue.length = 0;
      return;
    }
    // The first list is the baseline: only what arrives during this app session is an arrival.
    if (state.conversations === previous.conversations || !previous.conversationsLoaded) return;
    lookAt(previous.conversations, state.conversations);
  });

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
      unsubscribeStore();
      queue.length = 0;
      skippedBusy.clear();
    },
  };
}
