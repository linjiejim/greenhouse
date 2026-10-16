/**
 * Push rules on the phone, pure — no React, no Expo — so the root vitest pins them
 * (./model.test.ts).
 *
 * - `parsePushData`: a push's `data` as the server writes it (apps/api/src/modules/channels/push.ts
 *   `pushData`, still `v: 1`): who it is for, the notification, the conversation and card to
 *   open, the run and how it ended. Ids only, never content.
 * - `planTap`: a tap opens its source — on the station that sent it, switching there first when
 *   another station is active (signed in or not), and waiting for a sign-in when nobody is
 *   signed in there; a push for someone else (the phone changed hands) or a removed station
 *   just opens the app.
 * - `routeOf`: the source as one of the app's places (../lib/app-links.ts), rebuilt from
 *   validated ids — never a URL taken as given.
 * - `shouldPresent`: in the foreground, the conversation on screen stays quiet.
 * - `forConversation` / `staleIds`: which banners to clear — a conversation's own when it opens,
 *   a card decided elsewhere or a reply read elsewhere when the app comes back.
 * - `softAskDue`: the soft ask comes once per 14 days at most, and only while the system has
 *   not been asked.
 */

import { parseAppPath, type AppRoute } from '../lib/app-links';

/** What a push is about, as `data.k` says it (runs were "done" first). */
export type PushKind = 'needs_you' | 'replies' | 'done' | 'other' | 'test';

/** Every push's `data`: what the phone needs to route a tap. Never content. */
export interface PushData {
  v: 1;
  /** The device's own id for the station that sent it (`client_ref`): a tap from another station switches first. */
  s: string | null;
  /** The member it was for. */
  u: string;
  k: PushKind;
  /** The notification. */
  nid: string;
  /** The conversation it opens. */
  sid?: string;
  /** A 「需要你」 card to scroll to. */
  rid?: string;
  /** Where a tap goes: the web app's route without the hash (`/c/<id>`, `/runs/<id>`, …). */
  url?: string;
  /** A run that ended: the phone ends its Live Activity. */
  run?: string;
  st?: 'succeeded' | 'failed';
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const KINDS: ReadonlySet<string> = new Set<PushKind>(['needs_you', 'replies', 'done', 'other', 'test']);
const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

/** A received `data` object → `PushData`, or null when it is not one of ours. */
export function parsePushData(value: unknown): PushData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.v !== 1 || typeof data.k !== 'string' || !KINDS.has(data.k)) return null;
  if (!isId(data.u) || !isId(data.nid)) return null;
  // optional fields: absent is fine, present must be well-formed
  if (data.s != null && !isId(data.s)) return null;
  if (data.sid !== undefined && !isId(data.sid)) return null;
  if (data.rid !== undefined && !isId(data.rid)) return null;
  if (data.url !== undefined && (typeof data.url !== 'string' || data.url.length > 512)) return null;
  if (data.run !== undefined && !isId(data.run)) return null;
  if (data.st !== undefined && data.st !== 'succeeded' && data.st !== 'failed') return null;
  return {
    v: 1,
    s: isId(data.s) ? data.s : null,
    u: data.u,
    k: data.k as PushKind,
    nid: data.nid,
    ...(isId(data.sid) ? { sid: data.sid } : {}),
    ...(isId(data.rid) ? { rid: data.rid } : {}),
    ...(typeof data.url === 'string' ? { url: data.url } : {}),
    ...(isId(data.run) ? { run: data.run } : {}),
    ...(data.st === 'succeeded' || data.st === 'failed' ? { st: data.st } : {}),
  };
}

/** Where a tap goes: a conversation (with its card), another place of the app, or just the app. */
export type PushRoute =
  | { kind: 'conversation'; id: string; request: string }
  | { kind: 'place'; route: Exclude<AppRoute, { kind: 'conversation' | 'web' }> }
  | { kind: 'home' };

export function routeOf(data: PushData): PushRoute {
  if (data.k === 'test') return { kind: 'home' };
  const request = data.k === 'needs_you' ? (data.rid ?? '') : '';
  if (data.sid) return { kind: 'conversation', id: data.sid, request };
  const route = data.url ? parseAppPath(data.url) : null;
  if (!route) return { kind: 'home' };
  if (route.kind === 'conversation') return { kind: 'conversation', id: route.id, request };
  // knowledge and the rest have no screen here yet: the notification center lists it
  if (route.kind === 'web') return { kind: 'place', route: { kind: 'notifications' } };
  return { kind: 'place', route };
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

/** Show this notification while the app is in the foreground? The conversation on screen stays quiet. */
export function shouldPresent(input: {
  data: unknown;
  activeStationId: string | null;
  visibleConversation: string | null;
}): boolean {
  const data = parsePushData(input.data);
  if (!data || !data.sid || !input.visibleConversation) return true;
  const sameStation = !data.s || data.s === input.activeStationId;
  return !(sameStation && data.sid === input.visibleConversation);
}

export interface Presented {
  /** The notification request identifier (what `dismissNotificationAsync` takes). */
  id: string;
  data: unknown;
}

/** The banners of one conversation (to clear when it opens). */
export function forConversation(presented: readonly Presented[], stationId: string | null, sid: string): string[] {
  return presented
    .filter((item) => {
      const data = parsePushData(item.data);
      return !!data && data.sid === sid && (!data.s || data.s === stationId);
    })
    .map((item) => item.id);
}

/**
 * Banners that went stale while the app was away: a card that is no longer pending, a reply in
 * a conversation that is no longer unread. Only this station's — another station's facts are
 * unknown here.
 */
export function staleIds(
  presented: readonly Presented[],
  facts: { stationId: string | null; pendingRequestIds: ReadonlySet<string>; unreadConversationIds: ReadonlySet<string> },
): string[] {
  return presented
    .filter((item) => {
      const data = parsePushData(item.data);
      if (!data || (data.s && data.s !== facts.stationId)) return false;
      if (data.k === 'needs_you') return !!data.rid && !facts.pendingRequestIds.has(data.rid);
      if (data.k === 'replies') return !!data.sid && !facts.unreadConversationIds.has(data.sid);
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
