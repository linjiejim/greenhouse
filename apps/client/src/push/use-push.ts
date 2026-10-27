/**
 * `usePushBridge(ready)` — mounted once in the root layout, renders nothing. Runs this phone's
 * push side:
 *
 * - keeps the registration current: after sign-in / bootstrap / a station switch, on every
 *   return to the foreground, and when Expo issues a new token (./register.ts);
 * - opens a tapped notification once the routes are mounted (`ready`) — switching to the
 *   station that sent it first, then once someone is signed in there (./handler.ts);
 * - back in the foreground: refreshes the list, clears banners of notifications read elsewhere;
 * - keeps the app icon badge on the unread count while the app runs.
 */

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { goHome } from '../shell/nav';
import { openNotificationOrTarget } from '../shell/open-notification';
import { useOpenObject, useOpenTarget } from '../shell/open-object';
import { useAuth } from '../store/auth';
import { useNotifications } from '../store/notifications';
import { useStations } from '../store/stations';
import { clearReadBanners, onTap, resolvePendingTap, syncBadge } from './handler';
import { onDeviceTokenReported, PUSH_PLATFORM_READY, syncPush } from './register';
import { softAskWhenSettled } from './soft-ask';

export function usePushBridge(ready: boolean): void {
  const router = useRouter();
  const openObject = useOpenObject();
  const openTarget = useOpenTarget();
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
      if (!useAuth.getState().user) return;
      void useNotifications
        .getState()
        .refresh()
        .then(() => {
          void clearReadBanners({ all: true });
          void syncBadge();
          // the soft ask deferred from a sign-in comes now (src/push/soft-ask.ts)
          if (useNotifications.getState().status === 'ready') void softAskWhenSettled();
        });
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
    if (!route) return;
    if (route.kind === 'notification') void openNotificationOrTarget(route.id, { object: openObject, target: openTarget });
    else goHome(router);
  }, [ready, loading, user, identity, taps, router, openObject, openTarget]);

  // The badge follows the unread count while the app runs; signed out → none.
  const unread = useNotifications((s) => s.unread);
  useEffect(() => {
    if (!PUSH_PLATFORM_READY || loading) return;
    if (!user || unread >= 0) void syncBadge();
  }, [unread, user, loading]);
}
