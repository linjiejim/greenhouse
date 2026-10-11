/**
 * Mobile push — the wire contract between the server (`apps/api/src/notifications/push/`,
 * `/api/auth/me/push-devices`) and the phone (`apps/mobile/src/push/`). The app vendors
 * this file verbatim (`apps/mobile/src/shared/push.ts`, parity-tested), so it stays
 * dependency-free. Specs: docs/specs/20261010-mobile-push.md, and for `live_activity` /
 * `run` / `st` docs/specs/20261010-mobile-live-activity.md.
 */

/** What a member can switch per device. `preview` = the banner says what it is about. */
export interface PushPrefs {
  /** A Bot's card waits for the member (approve, sign in, take over, a proposal). */
  needs_you: boolean;
  /** A Bot's background task or a scheduled task finished. */
  done: boolean;
  /** A Bot replied and the member had not seen it anywhere a minute later. */
  replies: boolean;
  /** Show the subject / the first words in the banner (off: only who + what kind of thing). */
  preview: boolean;
  /**
   * This phone shows a Bot's background tasks as Live Activities (lock screen / Dynamic
   * Island). A task's "done" push then also wakes the app (`content-available`) so the
   * phone can end the activity in the background — a silent push when `done` is off.
   */
  live_activity: boolean;
}

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  needs_you: true,
  done: true,
  replies: true,
  preview: false,
  live_activity: false,
};

/** Every switch, in the order a settings page lists them. */
export const PUSH_PREF_KEYS = ['needs_you', 'done', 'replies', 'preview', 'live_activity'] as const;

/** Any value → complete prefs: booleans from `value` over `base`; anything else is ignored. */
export function normalizePushPrefs(value: unknown, base: PushPrefs = DEFAULT_PUSH_PREFS): PushPrefs {
  const next: PushPrefs = { ...base };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return next;
  const source = value as Record<string, unknown>;
  for (const key of PUSH_PREF_KEYS) {
    if (typeof source[key] === 'boolean') next[key] = source[key];
  }
  return next;
}

export type PushPlatform = 'ios';

/** The three kinds of push (spec §2.1). */
export type PushCategory = 'needs_you' | 'done' | 'replies';

/** How a Bot's background task ended, as its "done" push says (`PushData.st`). */
export type PushTaskOutcome = 'succeeded' | 'failed' | 'interrupted';

const TASK_OUTCOMES: ReadonlySet<string> = new Set<PushTaskOutcome>(['succeeded', 'failed', 'interrupted']);

/** One of the member's registered phones. The token itself never leaves the server. */
export interface PushDeviceView {
  id: string;
  platform: PushPlatform;
  client_ref: string | null;
  prefs: PushPrefs;
  created_at: string;
  last_seen_at: string;
}

/** `PUT /api/auth/me/push-devices` body. */
export interface PushDeviceRegisterRequest {
  token: string;
  platform: PushPlatform;
  project_id: string;
  client_ref?: string | null;
  prefs?: Partial<PushPrefs>;
}

/** `PUT` answer. `enabled: false` = this deployment has pushes off (nothing was stored). */
export interface PushDeviceRegisterResponse {
  device: PushDeviceView | null;
  enabled: boolean;
}

/** `GET /api/auth/me/push-devices`. */
export interface PushDeviceListResponse {
  devices: PushDeviceView[];
  enabled: boolean;
}

/** `PATCH /api/auth/me/push-devices/:id` body. */
export interface PushDevicePatchRequest {
  prefs: Partial<PushPrefs>;
}

/** Why `POST /api/auth/me/push-devices/:id/test` did not go out. */
export type PushTestErrorCode =
  | 'push_disabled'
  | 'device_disabled'
  | 'too_soon'
  | 'device_not_registered'
  | 'send_failed';

/** Every push's `data`: what the phone needs to route a tap. Never content; ≤ 1 KB. */
export interface PushData {
  v: 1;
  /** The device's own id for the station that sent it (`client_ref`): a tap from another station switches first. */
  s: string | null;
  /** The account it was for. */
  u: string;
  k: PushCategory | 'test';
  /** The conversation it opens: a Bots thread, or (a scheduled task's result) a chat session. */
  sid?: string;
  /** A "needs you" card to scroll to. */
  rid?: string;
  /** The notification fact. */
  nid: string;
  /** Where a tap goes: `/bots?c=<sid>[&request=<rid>]` or `/chat/<sid>`. */
  url?: string;
  /** done, a Bot's background task: its Runtime run — the phone ends that task's Live Activity. */
  run?: string;
  /** done, a Bot's background task: how it ended. */
  st?: PushTaskOutcome;
}

/** Ids the server writes into `data` (session / request / notification / station / user ids). */
const ID = /^[A-Za-z0-9._:-]{1,200}$/;

const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

/** A received `data` object → `PushData`, or null when it is not one of ours. */
export function parsePushData(value: unknown): PushData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.v !== 1) return null;
  if (data.k !== 'needs_you' && data.k !== 'done' && data.k !== 'replies' && data.k !== 'test') return null;
  if (!isId(data.u) || !isId(data.nid)) return null;
  // optional fields: absent is fine, present must be well-formed
  if (data.s != null && !isId(data.s)) return null;
  if (data.sid !== undefined && !isId(data.sid)) return null;
  if (data.rid !== undefined && !isId(data.rid)) return null;
  if (data.url !== undefined && (typeof data.url !== 'string' || data.url.length > 512)) return null;
  if (data.run !== undefined && !isId(data.run)) return null;
  if (data.st !== undefined && (typeof data.st !== 'string' || !TASK_OUTCOMES.has(data.st))) return null;
  return {
    v: 1,
    s: isId(data.s) ? data.s : null,
    u: data.u,
    k: data.k,
    nid: data.nid,
    ...(isId(data.sid) ? { sid: data.sid } : {}),
    ...(isId(data.rid) ? { rid: data.rid } : {}),
    ...(typeof data.url === 'string' ? { url: data.url } : {}),
    ...(isId(data.run) ? { run: data.run } : {}),
    ...(typeof data.st === 'string' && TASK_OUTCOMES.has(data.st) ? { st: data.st as PushTaskOutcome } : {}),
  };
}
