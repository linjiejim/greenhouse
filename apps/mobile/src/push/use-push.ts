/**
 * `usePushBridge(ready)` — mounted once in the root layout, renders nothing. Runs
 * this phone's push side (spec docs/specs/20261010-mobile-push.md §3.5):
 *
 * - keeps the registration current: after sign-in / bootstrap / a station switch,
 *   on every return to the foreground, and when Expo issues a new token (./register.ts);
 * - opens a tapped notification once the routes are mounted (`ready`) — switching to
 *   the station that sent it first, then once someone is signed in there (./handler.ts);
 * - clears banners: a thread's own when it opens, decided cards and read replies when
 *   the app comes back;
 * - keeps the app icon badge equal to the drawer's ☰ count while the app runs.
 */

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { botsEnabledNow } from '../bots/availability';
import { attentionCount, useBots } from '../bots/store';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { clearStaleBanners, clearThreadBanners, onTap, resolvePendingTap, syncBadge } from './handler';
import { hrefOf } from './model';
import { onDeviceTokenReported, PUSH_PLATFORM_READY, syncPush } from './register';

export function usePushBridge(ready: boolean): void {
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const loading = useAuth((s) => s.loading);
  const stationId = useStations((s) => s.activeId);
  const identity = `${stationId ?? ''}:${user?.id ?? ''}`;
  const [taps, setTaps] = useState(0);

  // Registration: per signed-in station + account, and on every return to the foreground.
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
      if (botsEnabledNow()) {
        const bots = useBots.getState();
        void Promise.all([bots.loadPending(), bots.loadConversations()]).then(() => {
          void clearStaleBanners();
          void syncBadge();
        });
      }
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
    if (route && route.kind !== 'home') router.push(hrefOf(route) as never);
  }, [ready, loading, user, identity, taps, router]);

  // A thread on screen: its banners go.
  const visibleThread = useBots((s) => s.visibleThread);
  useEffect(() => {
    if (visibleThread) void clearThreadBanners(visibleThread);
  }, [visibleThread]);

  // The badge follows the ☰ count while the app runs; signed out → none.
  const attention = useBots((s) => (s.conversationsLoaded ? attentionCount(s, null) : -1));
  useEffect(() => {
    if (!PUSH_PLATFORM_READY || loading) return;
    if (!user || attention >= 0) void syncBadge();
  }, [attention, user, loading]);
}
