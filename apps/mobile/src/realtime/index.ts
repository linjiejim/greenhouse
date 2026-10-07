/**
 * The app's one realtime connection (`/api/ws`) — the `Realtime` the thread
 * engines and the Bots store listen to (contract: src/bots/contract.ts).
 * Started and stopped only by <RealtimeBridge/> (./realtime-bridge.tsx,
 * mounted once in app/_layout.tsx), which owns the gates (iOS, internal
 * account, `bots` on, foreground).
 *
 * P0 STUB (spec docs/specs/20261008-mobile-bots.md §8 — package A replaces
 * it with src/api/ws.ts `RealtimeClient`): a connection that is never open,
 * so every consumer runs on its no-socket path (probes, reloads).
 */

import type { Realtime, RealtimeEvent, RealtimeStatus } from '../bots/contract';

/** When the (never-open) connection went "down": app start. */
const downSince = Date.now();

export const realtime: Realtime = {
  status: 'off' satisfies RealtimeStatus,
  on(_handler: (e: RealtimeEvent) => void) {
    return () => {};
  },
  onStatus(_listener: (s: RealtimeStatus) => void) {
    return () => {};
  },
  downSince: () => downSince,
};
