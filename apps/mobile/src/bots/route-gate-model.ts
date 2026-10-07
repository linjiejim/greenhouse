/**
 * The decision behind every Bots sheet's door (./route-gate.tsx), React-free
 * so the root vitest can run it (./route-gate-model.test.ts). Spec
 * docs/specs/20261008-mobile-bots.md §2.2 gate table, §2.5.8, §2.9: a
 * `bots/*` route reached while its gate is closed — a deep link on Android,
 * Bots switched off, an external account, a server that refused or has no
 * Bots — goes back home; on iOS the member is told "Bots aren't available",
 * on Android (no Bots surfaces in v1) it lands there quietly.
 */

/**
 * Which gate a route sits behind (./availability.ts):
 * - `threads` — the conversation surfaces (needs-you, cards, groups, invite,
 *   archived): an internal account with the server's `bots` feature on;
 * - `identity` — Bot identity (a Bot's profile): an internal account on a
 *   server that has Bots, whether or not the conversations are switched on.
 */
export type BotsRouteKind = 'threads' | 'identity';

/**
 * - `open` — render the sheet;
 * - `wait` — auth is loading (startup, a station switch: the gates read
 *   closed until the account is in) or signed out: render nothing and leave
 *   the move to the root layout (its spinner; its auth gate, which dismisses
 *   everything and shows the login page — an alert here would land on top);
 * - `home` — dismiss to home quietly (Android);
 * - `home-alert` — dismiss to home and say why (iOS).
 */
export type BotsRouteGate = 'open' | 'wait' | 'home' | 'home-alert';

export function botsRouteGate(input: {
  kind: BotsRouteKind;
  /** `useAuth`: `loading`, else whether there is a `user`. */
  auth: 'loading' | 'signed-out' | 'signed-in';
  /** `BOTS_PLATFORM_READY` — iOS in v1. */
  platformReady: boolean;
  /** `useBotsEnabled()`. */
  threadsOn: boolean;
  /** `useBotIdentityEnabled()`. */
  identityOn: boolean;
}): BotsRouteGate {
  if (input.auth !== 'signed-in') return 'wait';
  const open = input.kind === 'identity' ? input.identityOn : input.threadsOn;
  if (open) return 'open';
  return input.platformReady ? 'home-alert' : 'home';
}

/**
 * Sheets stack (a card's full view over needs-you), and one closed gate
 * closes them all at once: only the first bounce within `windowMs` navigates
 * and alerts — its `dismissTo('/')` already takes every sheet above home.
 */
export function bounceOnce(windowMs: number): (now: number) => boolean {
  let last = -Infinity;
  return (now) => {
    if (now - last < windowMs) return false;
    last = now;
    return true;
  };
}
