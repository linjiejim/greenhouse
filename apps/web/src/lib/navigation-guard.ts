/**
 * "Are you sure you want to leave?" for the hash router.
 *
 * A screen with unsaved work registers a guard; `useHashRouter` asks before it
 * commits a hash change and, when the guard says yes, holds the render on the
 * current screen and lets the app ask the user first.
 *
 * Why a module-level singleton rather than a store or context: the router reads
 * this inside a `hashchange` listener, synchronously, before React re-renders —
 * a subscription read would give it the previous render's value. There is only
 * ever one screen with unsaved work in front of the user, so one slot is enough;
 * registering a second guard replaces the first (the previous screen is being
 * torn down, and its cleanup only clears the slot if it still owns it).
 *
 * This covers in-app navigation only. Closing or reloading the tab is the
 * browser's own `beforeunload` prompt, which each screen adds for itself.
 */

type Guard = () => boolean;

let current: Guard | null = null;

/** Register a guard; call the returned function to release it (in effect cleanup). */
export function registerNavigationGuard(guard: Guard): () => void {
  current = guard;
  return () => {
    if (current === guard) current = null;
  };
}

/** True when the active screen has unsaved work and navigation should pause. */
export function navigationBlocked(): boolean {
  return current?.() === true;
}
