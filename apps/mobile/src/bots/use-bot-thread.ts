/**
 * `useBotThread(sessionId)` — a Bots thread's state for the screen: the
 * engine (src/bots/thread/engine.ts `ThreadEngine`, one per thread on
 * screen) read through `useSyncExternalStore`, plus its controller for
 * sends, stops, decisions and paging (contract: ./contract.ts).
 *
 * P0 STUB (spec docs/specs/20261008-mobile-bots.md §8 — package A replaces
 * it): a thread that stays loading, and a controller that does nothing (a
 * send reports "not delivered", a decision is refused), so the thread
 * screen compiles and renders its loading state.
 */

import { useMemo } from 'react';
import type { SendOutcome, ThreadController, ThreadSnapshot } from './contract';

const NOT_DELIVERED: SendOutcome = { ok: false, kind: 'not_delivered' };

function loadingSnapshot(sessionId: string): ThreadSnapshot {
  return {
    sessionId,
    load: 'loading',
    refreshFailed: false,
    conversation: null,
    messages: [],
    hasMore: false,
    earlier: 'idle',
    memoryStates: {},
    run: null,
    runActive: false,
    remoteBusy: false,
    stopPhase: null,
    pending: [],
    requests: new Map(),
    runError: null,
    readOnly: null,
  };
}

export function useBotThread(sessionId: string): { snap: ThreadSnapshot; ctl: ThreadController } {
  return useMemo(() => {
    const snap = loadingSnapshot(sessionId);
    const ctl: ThreadController = {
      getSnapshot: () => snap,
      subscribe: () => () => {},
      onEffect: () => () => {},
      setVisible: () => {},
      setForeground: () => {},
      send: async () => NOT_DELIVERED,
      retry: async () => NOT_DELIVERED,
      discard: () => {},
      stop: () => {},
      handleNow: async () => 'refused',
      decide: async () => ({ kind: 'refused', status: 0, code: null, message: '' }),
      loadEarlier: async () => {},
      reload: async () => {},
      dismissRunError: () => {},
    };
    return { snap, ctl };
  }, [sessionId]);
}
