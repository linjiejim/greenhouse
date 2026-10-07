/**
 * The door of every Bots sheet (`app/bots/*`): a route a deep link can open
 * whatever the gate says — `greenhouse://bots/needs-you` on Android, with Bots
 * switched off, for an external account — so each one checks it itself (spec
 * docs/specs/20261008-mobile-bots.md §2.2 gate table, §2.5.8, §2.9; the
 * decision: ./route-gate-model.ts). Closed → `dismissTo('/')` (no params:
 * home keeps the surface it was showing) plus "Bots aren't available" on iOS,
 * quietly on Android; the sheet renders nothing meanwhile, so none of its
 * loads fire. The gate is live: a 403 that closes the Bots while a sheet is up
 * (`useBots.error = 'forbidden'`) takes the member home the same way. While
 * auth is loading or signed out it only waits — the root layout owns those.
 *
 * No `app/bots/_layout.tsx` on purpose: a nested navigator would move the
 * sheets' presentations out of the root Stack. `app/bots/index.tsx` (the
 * `greenhouse://bots` forwarder) does its own check; the SwiftUI sheets have
 * `.android.tsx` forwarders for the platform half.
 */

import React, { useEffect, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { t } from '../lib/i18n';
import { useAuth } from '../store/auth';
import { alertError } from '../ui/dialogs';
import { BOTS_PLATFORM_READY, useBotIdentityEnabled, useBotsEnabled } from './availability';
import { botsRouteGate, bounceOnce, type BotsRouteKind } from './route-gate-model';

export type { BotsRouteKind } from './route-gate-model';

/** Stacked sheets closing together navigate (and alert) once. */
const bounce = bounceOnce(1500);

/** True while the route may render; once its gate closes it heads home (see the file header). */
export function useBotsRouteGate(kind: BotsRouteKind): boolean {
  const router = useRouter();
  const auth = useAuth((s) => (s.loading ? 'loading' : s.user ? 'signed-in' : 'signed-out'));
  const threadsOn = useBotsEnabled();
  const identityOn = useBotIdentityEnabled();
  const gate = botsRouteGate({ kind, auth, platformReady: BOTS_PLATFORM_READY, threadsOn, identityOn });

  useEffect(() => {
    if (gate === 'open' || gate === 'wait') return;
    if (!bounce(Date.now())) return;
    router.dismissTo('/');
    if (gate === 'home-alert') alertError(t('bots.nav.unavailable'));
  }, [gate, router]);

  return gate === 'open';
}

/** Renders `children` (the sheet) only while `useBotsRouteGate(kind)` is open. */
export function BotsRouteGate({ kind, children }: { kind: BotsRouteKind; children: ReactNode }) {
  return useBotsRouteGate(kind) ? <>{children}</> : null;
}
