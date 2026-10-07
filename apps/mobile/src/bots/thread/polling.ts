/**
 * The polling fallback for when the realtime socket is down (spec §2.7.3,
 * D6): nothing at all while it is open — the pushes say what changed — and a
 * steady beat once it has been down for `POLL_GRACE_MS` while the poller is
 * active (foreground; for a thread, also visible). A reconnect stops the beat
 * at once (the socket's `connected` frame triggers a full resync anyway).
 *
 * The grace counts from whichever is later, the moment the socket went down or
 * the moment the poller became active: back in the foreground after a long
 * background, the socket usually reconnects within a second, and that second
 * must not cost a poll.
 *
 * Used twice: the open thread (./engine.ts — probe the run every 8 s, reload
 * the newest page every 3rd beat) and the Bots lists (../sync.ts — every 30 s).
 */

import type { Realtime, ThreadDeps } from '../contract';

/** How long the socket must have been down (while active) before the first beat. */
export const POLL_GRACE_MS = 10_000;

export interface FallbackPoller {
  /** Foreground (and, for a thread, visible). Inactive = no beats. */
  setActive(active: boolean): void;
  dispose(): void;
}

export function createFallbackPoller(o: {
  realtime: Pick<Realtime, 'status' | 'onStatus' | 'downSince'>;
  clock: ThreadDeps['clock'];
  /** Time between beats once polling. */
  intervalMs: number;
  graceMs?: number;
  /** One beat; `n` counts beats since polling started (1, 2, 3…). */
  tick: (n: number) => void;
}): FallbackPoller {
  const { realtime, clock, intervalMs } = o;
  const grace = o.graceMs ?? POLL_GRACE_MS;
  let active = false;
  let activeSince = 0;
  let timer: unknown = null;
  let beats = 0;
  let disposed = false;

  const wanted = () => !disposed && active && realtime.status !== 'open';

  const stop = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    beats = 0;
  };

  const beat = () => {
    timer = null;
    if (!wanted()) {
      beats = 0;
      return;
    }
    beats += 1;
    timer = clock.setTimeout(beat, intervalMs);
    o.tick(beats);
  };

  const sync = () => {
    if (!wanted()) {
      stop();
      return;
    }
    // Already counting down (or polling): a change between down states keeps the cadence.
    if (timer !== null) return;
    const graceEnd = Math.max(realtime.downSince() ?? clock.now(), activeSince) + grace;
    timer = clock.setTimeout(beat, Math.max(0, graceEnd - clock.now()));
  };

  const unsubscribe = realtime.onStatus(sync);

  return {
    setActive(next) {
      if (next === active) return;
      active = next;
      if (next) activeSince = clock.now();
      sync();
    },
    dispose() {
      disposed = true;
      stop();
      unsubscribe();
    },
  };
}
