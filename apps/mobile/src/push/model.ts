/**
 * Push rules on the phone, pure — no React, no Expo — so the root vitest pins them
 * (./model.test.ts).
 *
 * - `parsePushData` (vendored contract, ../shared/push.ts): a push's `data` as the server writes
 *   it (apps/api/src/notifications/push/deliver.ts): who it is for, the notification, the route.
 *   Ids only, never content.
 * - `routeOf`: the notification to open, rebuilt from validated ids — never a URL taken as given.
 * - `planTap`: a tap opens its notification — on the station that sent it, switching there first
 *   when another station is active (signed in or not), and waiting for a sign-in when nobody is
 *   signed in there; a push for someone else (the phone changed hands) or a removed station
 *   just opens the app.
 * - `readBanners`: banners whose notification is read now (in the app or anywhere else) go.
 * - `softAskDue`: the soft ask comes once per 14 days at most, only while the system has not
 *   been asked, and never in the foreground session the member signed in during (iOS offers to
 *   save the password then; two alerts would stack).
 */

import { parsePushData } from '../shared/push';

export { parsePushData };

/** Where a tap goes: a notification, or just the app. */
export type PushRoute = { kind: 'notification'; id: string } | { kind: 'home' };

const NOTIFICATION_PATH = /^\/notification\?id=([A-Za-z0-9._:-]{1,200})$/;

export function routeOf(data: unknown): PushRoute {
  const push = parsePushData(data);
  if (!push || push.k === 'test') return { kind: 'home' };
  const fromUrl = push.url ? NOTIFICATION_PATH.exec(push.url)?.[1] : undefined;
  // the url must name the same notification the push is about
  if (push.url && fromUrl !== push.nid) return { kind: 'home' };
  return { kind: 'notification', id: push.nid };
}

export type TapPlan =
  | { action: 'ignore' }
  | { action: 'open'; route: PushRoute }
  | { action: 'switch'; stationId: string; route: PushRoute }
  /** Its station has nobody signed in: keep it until someone is (then theirs opens, anyone else's goes home). */
  | { action: 'wait' };

export function planTap(input: {
  /** `notification.request.content.data`. */
  data: unknown;
  activeStationId: string | null;
  knownStationIds: readonly string[];
  /** The member signed in on the active station (null while signed out). */
  userId: string | null;
}): TapPlan {
  const data = parsePushData(input.data);
  if (!data) return { action: 'ignore' };
  const route = routeOf(data);
  const station = data.s;
  // the station that sent it comes first — whether or not the active one is signed in
  if (station && station !== input.activeStationId) {
    return input.knownStationIds.includes(station)
      ? { action: 'switch', stationId: station, route }
      : { action: 'open', route: { kind: 'home' } };
  }
  if (route.kind === 'home') return { action: 'open', route };
  if (!input.userId) return { action: 'wait' };
  // same station, someone else's push (the phone changed hands since): not theirs to open
  if (data.u !== input.userId) return { action: 'open', route: { kind: 'home' } };
  return { action: 'open', route };
}

/** Show this push while the app is in the foreground? Not when its notification is on screen. */
export function shouldPresent(input: {
  data: unknown;
  activeStationId: string | null;
  visibleNotification: string | null;
}): boolean {
  const data = parsePushData(input.data);
  if (!data || !input.visibleNotification) return true;
  const sameStation = !data.s || data.s === input.activeStationId;
  return !(sameStation && data.nid === input.visibleNotification);
}

export interface Presented {
  /** The notification request identifier (what `dismissNotificationAsync` takes). */
  id: string;
  data: unknown;
}

/**
 * Banners whose notification is read now: those in `readIds`, and — once the unread list is
 * known (`unreadIds`) — every banner of this station not in it. Another station's banners stay:
 * its facts are unknown here.
 */
export function readBanners(
  presented: readonly Presented[],
  facts: { stationId: string | null; readIds?: ReadonlySet<string>; unreadIds?: ReadonlySet<string> },
): string[] {
  return presented
    .filter((item) => {
      const data = parsePushData(item.data);
      if (!data || data.k === 'test' || (data.s && data.s !== facts.stationId)) return false;
      if (facts.readIds?.has(data.nid)) return true;
      return facts.unreadIds ? !facts.unreadIds.has(data.nid) : false;
    })
    .map((item) => item.id);
}

export const SOFT_ASK_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

export type PushPermission = 'undetermined' | 'granted' | 'denied';

/**
 * Ask softly now? Only while the system was never asked, the station pushes, not within 14 days of
 * the last ask, and not before the app has come to the foreground again since a sign-in on this
 * phone (`signedInAt` after `foregroundAt`: the sign-in happened in this foreground session).
 */
export function softAskDue(input: {
  permission: PushPermission;
  supported: boolean;
  lastAskedAt: number | null;
  now: number;
  /** When the member signed in on the sign-in page (null: the session was restored). */
  signedInAt?: number | null;
  /** When the app last came to the foreground (or launched). */
  foregroundAt?: number;
}): boolean {
  if (!input.supported || input.permission !== 'undetermined') return false;
  if (input.signedInAt != null && input.signedInAt >= (input.foregroundAt ?? 0)) return false;
  return input.lastAskedAt === null || input.now - input.lastAskedAt >= SOFT_ASK_COOLDOWN_MS;
}

/** Remembers handled taps (cold start and the response listener can both report the launch tap). */
export function createTapLedger(max = 50) {
  const seen: string[] = [];
  return {
    /** True the first time an identifier is seen. */
    first(id: string): boolean {
      if (seen.includes(id)) return false;
      seen.push(id);
      if (seen.length > max) seen.shift();
      return true;
    },
  };
}
