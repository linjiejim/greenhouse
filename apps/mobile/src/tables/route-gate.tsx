/**
 * The door of every Tables / Apps route (`app/tables/*`, `app/forms/*`,
 * `app/apps/*`, `app/peek/record`): a deep link, a push or an entity link can
 * open any of them whatever the gate says (Android, the switch off, an external
 * account), so each one checks it itself — the same decision as the Bots routes
 * (../bots/route-gate-model.ts: closed → `dismissTo('/')`, with "… isn't
 * available" on iOS, quietly on Android; signed out / loading → wait for the
 * root layout). The sheet renders nothing while closed, so none of its loads
 * fire; an open gate renders it in the same pass (a SwiftUI Form must mount on
 * the first frame), and a `latched` sheet stays mounted until the navigation
 * removes it (deleting a Form under a focused field crashes UIKit).
 */

import React, { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { t } from '../lib/i18n';
import { useAuth } from '../store/auth';
import { alertError } from '../ui/dialogs';
import { botsGateShows, bounceOnce } from '../bots/route-gate-model';
import { TABLES_PLATFORM_READY, useAppsEnabled, useTablesEnabled, type TablesArea } from './availability';

const bounce = bounceOnce(1500);

/**
 * True while the route may render. `area`: which switch it sits behind —
 * `'internal'` requires only iOS and an internal account (a submit-only form is
 * not behind the Tables switch, foundation D5; the notification list).
 */
export function useTablesRouteGate(area: TablesArea | 'internal'): boolean {
  const router = useRouter();
  const auth = useAuth((s) => (s.loading ? 'loading' : s.user ? 'signed-in' : 'signed-out'));
  const internal = useAuth((s) => s.user?.role === 'team' || s.user?.role === 'super');
  const tablesOn = useTablesEnabled();
  const appsOn = useAppsEnabled();
  const on = area === 'tables' ? tablesOn : area === 'apps' ? appsOn : TABLES_PLATFORM_READY && internal;
  const gate = auth !== 'signed-in' ? 'wait' : on ? 'open' : TABLES_PLATFORM_READY ? 'home-alert' : 'home';

  useEffect(() => {
    if (gate === 'open' || gate === 'wait') return;
    if (!bounce(Date.now())) return;
    router.dismissTo('/');
    if (gate === 'home-alert') alertError(t(area === 'apps' ? 'apps.unavailable' : 'tables.unavailable'));
  }, [gate, router, area]);

  return gate === 'open';
}

export function TablesRouteGate({
  area,
  latched = false,
  children,
}: {
  area: TablesArea | 'internal';
  latched?: boolean;
  children: ReactNode;
}) {
  const open = useTablesRouteGate(area);
  const [wasOpen, setWasOpen] = useState(open);
  // remembered during render, so it holds from the very render that opened it
  if (open && !wasOpen) setWasOpen(true);
  return botsGateShows({ open, wasOpen, latched }) ? <>{children}</> : null;
}
