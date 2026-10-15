/**
 * `usePushBridge(ready)` — mounted once in the root layout, renders nothing. Runs this phone's
 * push side:
 *
 * - keeps the registration current: after sign-in / bootstrap / a station switch, on every
 *   return to the foreground, and when Expo issues a new token (./register.ts);
 * - opens a tapped notification once the routes are mounted (`ready`) — switching to the
 *   station that sent it first, then once someone is signed in there (./handler.ts);
 * - clears banners of decided cards and read replies when the app comes back;
 * - keeps the app icon badge on the bell's number while the app runs.
 */

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { openAppRoute, openConversation } from '../shell/nav';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { useWorkspace } from '../store/workspace';
import { clearStaleBanners, onTap, resolvePendingTap, syncBadge } from './handler';
import type { PushRoute } from './model';
import { onDeviceTokenReported, PUSH_PLATFORM_READY, syncPush } from './register';

/** Opens where a tapped push points. */
function openRoute(router: ReturnType<typeof useRouter>, route: PushRoute): void {
  if (route.kind === 'conversation') openConversation(router, { id: route.id, request: route.request }, 'dismissTo');
  else if (route.kind === 'place') openAppRoute(router, route.route);
}

export function usePushBridge(ready: boolean): void {
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const loading = useAuth((s) => s.loading);
  const stationId = useStations((s) => s.activeId);
  const identity = `${stationId ?? ''}:${user?.id ?? ''}`;
  const [taps, setTaps] = useState(0);

  // Registration: per signed-in station + member, and on every return to the foreground.
  useEffect(() => {
    if (!PUSH_PLATFORM_READY || loading) return;
    void syncPush();
  }, [identity, loading]);
  useEffect(() => {
    if (!PUSH_PLATFORM_READY) return;
    const app = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        void syncBadge();
        return;
      }
      void syncPush();
      void Promise.all([useWorkspace.getState().refreshSummary(), useWorkspace.getState().refreshConversations()]).then(
        () => {
          void clearStaleBanners();
          void syncBadge();
        },
      );
    });
    const token = Notifications.addPushTokenListener(onDeviceTokenReported);
    return () => {
      app.remove();
      token.remove();
    };
  }, []);

  // Taps: once the routes are up — switching station first even from a signed-out one; a
  // route opens once someone is signed in (a switch / sign-in re-runs this via `identity`).
  useEffect(() => onTap(() => setTaps((n) => n + 1)), []);
  useEffect(() => {
    if (!PUSH_PLATFORM_READY || !ready || loading) return;
    const route = resolvePendingTap();
    if (route) openRoute(router, route);
  }, [ready, loading, user, identity, taps, router]);

  // The badge follows the bell while the app runs; signed out → none.
  const unread = useWorkspace((s) => (s.summary ? s.summary.unread : -1));
  useEffect(() => {
    if (!PUSH_PLATFORM_READY || loading) return;
    if (!user || unread >= 0) void syncBadge();
  }, [unread, user, loading]);
}
