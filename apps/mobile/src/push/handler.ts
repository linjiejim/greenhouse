/**
 * What a push does on the phone (spec docs/specs/20261010-mobile-push.md §2.2, §3.5) —
 * the Expo side; the rules themselves are pure in ./model.ts.
 *
 * - Installed at import (the root layout imports it): the foreground presenter keeps
 *   the thread on screen quiet (`shouldPresent` over `useBots.visibleThread`), and
 *   the tap that launched the app is captured before React renders — so the home
 *   screen's cold-start restore (`launchedByPush`) gives way to it.
 * - A tap (at launch, or later through the response listener; the ledger handles
 *   each once) waits until auth is settled, switches to the station that sent it
 *   when another is active — signed in there or not (`switchStation`, then waits
 *   again) — and, once someone is signed in on its station, opens it through the
 *   existing deep links (`/bots?c=&request=` → its thread and card, `/chat/<id>` →
 *   the session).
 * - Banners are cleared when their thread opens, and — back in the foreground — when
 *   their card was decided or their reply read somewhere else.
 */

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useAuth } from '../store/auth';
import { useStations } from '../store/stations';
import { attentionCount, useBots } from '../bots/store';
import { createTapLedger, forThread, planTap, shouldPresent, staleIds, type PushRoute, type Presented } from './model';

const READY = Platform.OS === 'ios';
const ledger = createTapLedger();

/** The tap waiting to be opened (launch or listener); `switched` once its station switch was started. */
let pendingTap: { id: string; data: unknown; switched?: boolean } | null = null;
const tapListeners = new Set<() => void>();
/** The process was launched by tapping a notification (never reset: the restore decides once per process). */
let launchTap = false;

function takeResponse(response: Notifications.NotificationResponse | null, atLaunch: boolean): void {
  if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  const id = response.notification.request.identifier;
  if (!ledger.first(id)) return;
  pendingTap = { id, data: response.notification.request.content.data };
  if (atLaunch) launchTap = true;
  tapListeners.forEach((listener) => listener());
}

if (READY) {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const show = shouldPresent({
        data: notification.request.content.data,
        activeStationId: useStations.getState().activeId,
        visibleThread: useBots.getState().visibleThread,
      });
      // the badge is the app's own while it runs (see syncBadge)
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
    },
  });
  try {
    takeResponse(Notifications.getLastNotificationResponse(), true);
  } catch {
    // no native module (a binary without expo-notifications): nothing to route
  }
  Notifications.addNotificationResponseReceivedListener((response) => takeResponse(response, false));
}

export function launchedByPush(): boolean {
  return launchTap;
}

export function onTap(listener: () => void): () => void {
  tapListeners.add(listener);
  return () => tapListeners.delete(listener);
}

/**
 * Act on the pending tap when the app can. Returns the route to open now, or null:
 * nothing pending, or not yet — a station switch was started (the active station may
 * be signed out; the push's own is what counts), or the push's station has nobody
 * signed in (it opens after sign-in — for its own account; anyone else lands home).
 */
export function resolvePendingTap(): PushRoute | null {
  if (!pendingTap) return null;
  const { user, loading } = useAuth.getState();
  if (loading) return null;
  const stations = useStations.getState();
  const plan = planTap({
    data: pendingTap.data,
    activeStationId: stations.activeId,
    knownStationIds: stations.stations.map((station) => station.id),
    userId: user?.id ?? null,
  });
  if (plan.action === 'switch') {
    if (pendingTap.switched) {
      pendingTap = null; // the switch didn't take: never loop on it
      return null;
    }
    // keep it pending: on its own station the plan is `open`
    pendingTap.switched = true;
    void useAuth.getState().switchStation(() => useStations.getState().switchTo(plan.stationId));
    return null;
  }
  if (plan.action === 'wait') return null;
  pendingTap = null;
  void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  return plan.action === 'open' ? plan.route : null;
}

async function presented(): Promise<Presented[]> {
  const list = await Notifications.getPresentedNotificationsAsync();
  return list.map((item) => ({ id: item.request.identifier, data: item.request.content.data }));
}

/** The thread on screen: its banners go. */
export async function clearThreadBanners(sid: string): Promise<void> {
  if (!READY) return;
  try {
    const ids = forThread(await presented(), useStations.getState().activeId, sid);
    await Promise.all(ids.map((id) => Notifications.dismissNotificationAsync(id)));
  } catch {
    // cosmetic
  }
}

/** Back in the foreground: banners whose card was decided / whose reply was read elsewhere go. */
export async function clearStaleBanners(): Promise<void> {
  if (!READY) return;
  const bots = useBots.getState();
  if (!bots.conversationsLoaded) return;
  try {
    const ids = staleIds(await presented(), {
      stationId: useStations.getState().activeId,
      pendingRequestIds: new Set(bots.pendingRequests.filter((r) => r.status === 'pending').map((r) => r.id)),
      unreadSessionIds: new Set(
        bots.conversations.filter((row) => row.attention === 'unread').map((row) => row.session_id),
      ),
    });
    await Promise.all(ids.map((id) => Notifications.dismissNotificationAsync(id)));
  } catch {
    // cosmetic
  }
}

/** The app icon badge = conversations that need the member or hold something unread (the ☰ rule, spec D7). */
export async function syncBadge(): Promise<void> {
  if (!READY) return;
  const signedIn = !!useAuth.getState().user;
  const bots = useBots.getState();
  if (signedIn && !bots.conversationsLoaded) return;
  try {
    await Notifications.setBadgeCountAsync(signedIn ? attentionCount(bots, null) : 0);
  } catch {
    // no badge permission: nothing to show
  }
}
