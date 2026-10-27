/**
 * What a push does on the phone — the Expo side; the rules themselves are pure in ./model.ts.
 *
 * - Installed at import (the root layout imports it): the foreground presenter keeps the
 *   notification on screen quiet (`shouldPresent` over ../shell/surface.ts), and the tap that
 *   launched the app is captured before React renders.
 * - A tap (at launch, or later through the response listener; the ledger handles each once)
 *   waits until auth is settled, switches to the station that sent it when another is active —
 *   signed in there or not (`switchStation`, then waits again) — and, once someone is signed in
 *   on its station, opens its notification.
 * - Banners of notifications read in the app or elsewhere go (`clearReadBanners`).
 * - The app icon badge is the unread count.
 */

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { visibleNotification } from '../shell/surface';
import { useAuth } from '../store/auth';
import { useNotifications } from '../store/notifications';
import { useStations } from '../store/stations';
import {
  createTapLedger,
  planTap,
  readBanners,
  shouldPresent,
  stationBanners,
  type Presented,
  type PushRoute,
} from './model';

const READY = Platform.OS === 'ios' || Platform.OS === 'android';
const ledger = createTapLedger();

/** The tap waiting to be opened (launch or listener); `switched` once its station switch was started. */
let pendingTap: { id: string; data: unknown; switched?: boolean } | null = null;
const tapListeners = new Set<() => void>();

function takeResponse(response: Notifications.NotificationResponse | null): void {
  if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
  const id = response.notification.request.identifier;
  if (!ledger.first(id)) return;
  pendingTap = { id, data: response.notification.request.content.data };
  tapListeners.forEach((listener) => listener());
}

if (READY) {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const show = shouldPresent({
        data: notification.request.content.data,
        activeStationId: useStations.getState().activeId,
        visibleNotification: visibleNotification(),
      });
      // a push in the foreground is news for the list too
      void useNotifications.getState().refresh();
      // the badge is the app's own while it runs (see syncBadge)
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
    },
  });
  try {
    takeResponse(Notifications.getLastNotificationResponse());
  } catch {
    // no native module (a binary without expo-notifications): nothing to route
  }
  Notifications.addNotificationResponseReceivedListener((response) => takeResponse(response));
}

export function onTap(listener: () => void): () => void {
  tapListeners.add(listener);
  return () => tapListeners.delete(listener);
}

/**
 * Act on the pending tap when the app can. Returns the route to open now, or null: nothing
 * pending, or not yet — a station switch was started (the active station may be signed out;
 * the push's own is what counts), or the push's station has nobody signed in (it opens after
 * sign-in — for its own member; anyone else lands home).
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

/**
 * Banners whose notification is known to be read go: `readIds` just read in the app; with `all`,
 * also every notification the loaded list shows as read (a foreground refresh). Banners of
 * notifications the list has not loaded stay — absence from the first pages says nothing.
 */
export async function clearReadBanners(input: { readIds?: string[]; all?: boolean }): Promise<void> {
  if (!READY || !useAuth.getState().user) return;
  try {
    const { items, status } = useNotifications.getState();
    const readIds = new Set(input.readIds ?? []);
    if (input.all && status === 'ready') for (const n of items) if (n.read_at) readIds.add(n.id);
    const ids = readBanners(await presented(), { stationId: useStations.getState().activeId, readIds });
    await Promise.all(ids.map((id) => Notifications.dismissNotificationAsync(id)));
  } catch {
    // cosmetic
  }
}

/** The server confirmed "mark all read": every banner this station delivered is read now. */
export async function clearAllStationBanners(): Promise<void> {
  if (!READY || !useAuth.getState().user) return;
  try {
    const ids = stationBanners(await presented(), useStations.getState().activeId);
    await Promise.all(ids.map((id) => Notifications.dismissNotificationAsync(id)));
  } catch {
    // cosmetic
  }
}

/** The app icon badge counts unread notifications (0 signed out). */
export async function syncBadge(): Promise<void> {
  if (!READY) return;
  const signedIn = !!useAuth.getState().user;
  const unread = useNotifications.getState().unread;
  if (signedIn && unread < 0) return;
  try {
    await Notifications.setBadgeCountAsync(signedIn ? unread : 0);
  } catch {
    // no badge permission: nothing to show
  }
}
