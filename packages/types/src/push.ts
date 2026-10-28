/**
 * Mobile push — the wire contract between the server (`apps/api/src/notifications/push/`,
 * `/api/auth/me/push-devices`) and the phone app (`apps/client/src/push/`). The app vendors
 * this file verbatim (`apps/client/src/shared/push.ts`, guarded by a parity test), so it stays
 * dependency-free.
 *
 * Every notification-center fact can become a push. What it is about decides its category
 * (`pushCategoryOf`): something waits for the member, something finished, or anything else.
 * A push never carries content unless the member switched previews on for that phone.
 */

/** What a member can switch per phone. `preview` = the banner names what it is about. */
export interface PushPrefs {
  /** Something waits for the member (an approval, an answer, a budget limit). */
  needs_you: boolean;
  /** A run or a scheduled task finished or failed. */
  done: boolean;
  /** Every other notification. */
  other: boolean;
  /** Show the notification's title in the banner (off: only what kind of thing happened). */
  preview: boolean;
}

export const DEFAULT_PUSH_PREFS: PushPrefs = { needs_you: true, done: true, other: true, preview: false };

export const PUSH_PREF_KEYS = ['needs_you', 'done', 'other', 'preview'] as const;

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

export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/** The three kinds of push, one switch each. */
export type PushCategory = 'needs_you' | 'done' | 'other';

/** A notification kind → its push category. Kinds this file does not know are `other`. */
export function pushCategoryOf(kind: string): PushCategory {
  if (kind === 'runtime_attention' || kind === 'budget_attention') return 'needs_you';
  if (kind === 'runtime_completed' || kind === 'runtime_failed') return 'done';
  return 'other';
}

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

/** Every push's `data`: what the phone needs to route a tap. Never content; well under 1 KB. */
export interface PushData {
  v: 1;
  /** The phone's own id for the station that sent it (`client_ref`): a tap from another station switches first. */
  s: string | null;
  /** The account it was for. */
  u: string;
  k: PushCategory | 'test';
  /** The notification fact (`test` for a test push). */
  nid: string;
  /** Where a tap goes in the app: `/notification?id=<nid>`. */
  url?: string;
}

/** Ids the server writes into `data` (notification / station / user ids). */
const ID = /^[A-Za-z0-9._:-]{1,200}$/;

const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

/** The app route a push for this notification opens. */
export function pushUrl(notificationId: string): string {
  return `/notification?id=${encodeURIComponent(notificationId)}`;
}

/** A received `data` object → `PushData`, or null when it is not one of ours. */
export function parsePushData(value: unknown): PushData | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.v !== 1) return null;
  if (data.k !== 'needs_you' && data.k !== 'done' && data.k !== 'other' && data.k !== 'test') return null;
  if (!isId(data.u) || !isId(data.nid)) return null;
  // optional fields: absent is fine, present must be well-formed
  if (data.s != null && !isId(data.s)) return null;
  if (data.url !== undefined && (typeof data.url !== 'string' || data.url.length > 512 || !data.url.startsWith('/')))
    return null;
  return {
    v: 1,
    s: isId(data.s) ? data.s : null,
    u: data.u,
    k: data.k,
    nid: data.nid,
    ...(typeof data.url === 'string' ? { url: data.url } : {}),
  };
}
