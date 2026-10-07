/**
 * Bots client state (zustand): the member's Bots, their conversations, the
 * "needs you" cards, which conversations are busy, and the reports that landed
 * elsewhere. The logic and the selectors live in ./store-core.ts (pure, tested
 * in the root vitest); this module binds them to zustand and the real API.
 *
 * Everything here belongs to one member on one station: the store resets
 * itself whenever the signed-in user or the active station changes
 * (subscriptions at the bottom — the src/store/tags.ts pattern).
 */

import { create } from 'zustand';
import * as botsApi from '../api/bots';
import { listChatRuns } from '../api/chat';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { createBotsSlice, type BotsState } from './store-core';

export {
  attentionCount,
  capsuleItem,
  drawerRows,
  rowSignal,
  sproutyBot,
  sproutyDm,
  type Arrival,
  type BotsState,
  type CapsuleItem,
  type DrawerRows,
} from './store-core';

export const useBots = create<BotsState>()((set, get) =>
  createBotsSlice(set, get, {
    api: { ...botsApi, listChatRuns },
    clock: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  }),
);

// Per account per station — drop the cache when either changes.
useAuth.subscribe((s, prev) => {
  if ((s.user?.id ?? null) !== (prev.user?.id ?? null)) useBots.getState().reset();
});
useStations.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) useBots.getState().reset();
});
