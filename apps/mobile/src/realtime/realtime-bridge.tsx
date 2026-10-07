/**
 * <RealtimeBridge/> — mounted once in app/_layout.tsx, renders nothing: starts
 * and stops the realtime connection (./index.ts) with the app's state —
 * signed in on an internal account with `bots` on, in the foreground — and
 * routes its events into the Bots store (spec docs/specs/20261008-mobile-bots.md
 * §2.7.2).
 *
 * P0 STUB (package A implements it): does nothing yet.
 */

export function RealtimeBridge(): null {
  return null;
}
