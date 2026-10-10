/**
 * Push rules on the phone, pure — no React, no Expo — so the root vitest pins them
 * (./model.test.ts). Spec: docs/specs/20261010-mobile-push.md §2.2–§2.4, §3.5.
 *
 * - `planTap`: a tap opens its conversation — on the station that sent it, switching
 *   there first when another station is active (signed in or not), and waiting for a
 *   sign-in when nobody is signed in there; a push for someone else (the phone
 *   changed hands) or a removed station just opens the app.
 * - `routeOf` / `hrefOf`: only the app's existing deep links (`/bots?c=&request=`,
 *   `/chat/<id>`), rebuilt from validated ids — never a URL taken as given.
 * - `shouldPresent`: in the foreground, the thread on screen stays quiet.
 * - `forThread` / `staleIds`: which banners to clear — a thread's own when it opens,
 *   a card decided elsewhere or a reply read elsewhere when the app comes back.
 * - `softAskDue`: the soft ask comes once per 14 days at most, and only while the
 *   system has not been asked.
 */

import { parsePushData, type PushData } from '../shared/push';

export type PushRoute =
  | { kind: 'thread'; c: string; request: string }
  | { kind: 'chat'; id: string }
  | { kind: 'home' };

const ID = /^[A-Za-z0-9._:-]{1,200}$/;

/** Where a push's tap goes, from its `url` (validated against its own ids) or its kind. */
export function routeOf(data: PushData): PushRoute {
  const url = data.url ?? '';
  const bots = /^\/bots\?c=([^&]+)(?:&request=([^&]+))?$/.exec(url);
  if (bots) {
    const c = decodeURIComponent(bots[1]!);
    const request = bots[2] ? decodeURIComponent(bots[2]) : '';
    if (ID.test(c) && (!request || ID.test(request))) return { kind: 'thread', c, request };
    return { kind: 'home' };
  }
  const chat = /^\/chat\/([^/?#]+)$/.exec(url);
  if (chat) {
    const id = decodeURIComponent(chat[1]!);
    return ID.test(id) ? { kind: 'chat', id } : { kind: 'home' };
  }
  // no (usable) url: a card or a reply always lives in a Bots thread
  if ((data.k === 'needs_you' || data.k === 'replies') && data.sid) {
    return { kind: 'thread', c: data.sid, request: data.k === 'needs_you' ? (data.rid ?? '') : '' };
  }
  return { kind: 'home' };
}

/** The router path of a route — the deep-link forwarders (`app/bots/index.tsx`, `app/chat/[id].tsx`) take it from there. */
export function hrefOf(route: PushRoute): string {
  if (route.kind === 'thread') {
    return `/bots?c=${encodeURIComponent(route.c)}${route.request ? `&request=${encodeURIComponent(route.request)}` : ''}`;
  }
  if (route.kind === 'chat') return `/chat/${encodeURIComponent(route.id)}`;
  return '/';
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
  /** The account signed in on the active station (null while signed out). */
  userId: string | null;
}): TapPlan {
  const data = parsePushData(input.data);
  if (!data) return { action: 'ignore' };
  const route = data.k === 'test' ? ({ kind: 'home' } as const) : routeOf(data);
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

/** Show this notification while the app is in the foreground? The thread on screen stays quiet (spec §2.2). */
export function shouldPresent(input: {
  data: unknown;
  activeStationId: string | null;
  visibleThread: string | null;
}): boolean {
  const data = parsePushData(input.data);
  if (!data || !data.sid || !input.visibleThread) return true;
  const sameStation = !data.s || data.s === input.activeStationId;
  return !(sameStation && data.sid === input.visibleThread);
}

export interface Presented {
  /** The notification request identifier (what `dismissNotificationAsync` takes). */
  id: string;
  data: unknown;
}

/** The banners of one conversation (to clear when it opens). */
export function forThread(presented: readonly Presented[], stationId: string | null, sid: string): string[] {
  return presented
    .filter((item) => {
      const data = parsePushData(item.data);
      return !!data && data.sid === sid && (!data.s || data.s === stationId);
    })
    .map((item) => item.id);
}

/**
 * Banners that went stale while the app was away: a card that is no longer pending,
 * a reply in a conversation that is no longer unread. Only this station's — another
 * station's facts are unknown here.
 */
export function staleIds(
  presented: readonly Presented[],
  facts: { stationId: string | null; pendingRequestIds: ReadonlySet<string>; unreadSessionIds: ReadonlySet<string> },
): string[] {
  return presented
    .filter((item) => {
      const data = parsePushData(item.data);
      if (!data || (data.s && data.s !== facts.stationId)) return false;
      if (data.k === 'needs_you') return !!data.rid && !facts.pendingRequestIds.has(data.rid);
      if (data.k === 'replies') return !!data.sid && !facts.unreadSessionIds.has(data.sid);
      return false;
    })
    .map((item) => item.id);
}

export const SOFT_ASK_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

export type PushPermission = 'undetermined' | 'granted' | 'denied';

/** Ask softly now? Only while the system was never asked, the station pushes, and not within 14 days of the last ask. */
export function softAskDue(input: {
  permission: PushPermission;
  supported: boolean;
  lastAskedAt: number | null;
  now: number;
}): boolean {
  if (!input.supported || input.permission !== 'undetermined') return false;
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
