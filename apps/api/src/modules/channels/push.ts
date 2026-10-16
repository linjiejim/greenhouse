/**
 * Whether a notification becomes a push on one phone, and what the push carries. Pure.
 *
 * - The phone's own switch for the category can only narrow the member's settings. A run's end
 *   on a phone that shows runs as Live Activities still goes out, silently, when that switch is
 *   off: it only wakes the app to end the activity.
 * - A push never outlives what it is about: a card's own deadline, else a day.
 * - `data` keeps the shape the phone apps parse (`v: 1`): who it is for, the notification, the
 *   conversation and card to open, the run and how it ended. Never content.
 */

import type { PushMessage } from '@greenhouse/providers';
import type { NotificationCategory, NotificationRow, PushPrefs } from '@greenhouse/db';
import { linkPath } from './render.js';

/** A finished run or reply that could not be delivered within a day is no longer news. */
export const PUSH_TTL_MS = 24 * 60 * 60 * 1000;

const DEVICE_SWITCH: Record<NotificationCategory, keyof PushPrefs | null> = {
  needs_you: 'needs_you',
  replies: 'replies',
  runs: 'done',
  other: null,
};

/** The category as the apps name it in `data.k` (runs were "done" there first). */
const PUSH_KIND: Record<NotificationCategory, string> = {
  needs_you: 'needs_you',
  replies: 'replies',
  runs: 'done',
  other: 'other',
};

/** The cards that cannot wait and may break through Focus. */
const TIME_SENSITIVE = new Set(['approval', 'login', 'takeover']);

export type PushDecision =
  | { send: false; reason: 'device_off' | 'expired' }
  | { send: true; silent: boolean; expiresAt: number; interruptionLevel: 'time-sensitive' | 'active' };

export const isRunEnd = (notification: Pick<NotificationRow, 'kind' | 'runId'>) =>
  !!notification.runId && (notification.kind === 'run_done' || notification.kind === 'run_failed');

export function pushDecision(input: {
  category: NotificationCategory;
  prefs: PushPrefs;
  runEnd: boolean;
  requestKind?: string | null;
  /** A needs-you card's own deadline. */
  requestExpiresAt?: string | null;
  createdAt: string;
  now: number;
}): PushDecision {
  const key = DEVICE_SWITCH[input.category];
  const on = key ? input.prefs[key] : true;
  const silent = !on && input.runEnd && input.prefs.live_activity;
  if (!on && !silent) return { send: false, reason: 'device_off' };
  const deadline =
    input.category === 'needs_you' && input.requestExpiresAt ? Date.parse(input.requestExpiresAt) : Number.NaN;
  const created = Date.parse(input.createdAt);
  const expiresAt = Number.isFinite(deadline)
    ? deadline
    : (Number.isFinite(created) ? created : input.now) + PUSH_TTL_MS;
  if (expiresAt <= input.now) return { send: false, reason: 'expired' };
  return {
    send: true,
    silent,
    expiresAt,
    interruptionLevel:
      input.category === 'needs_you' && TIME_SENSITIVE.has(input.requestKind ?? '') ? 'time-sensitive' : 'active',
  };
}

/** What a tap needs to route: ids only, a few hundred bytes. */
export function pushData(input: {
  notification: Pick<NotificationRow, 'id' | 'kind' | 'targetType' | 'targetId' | 'requestId' | 'runId'>;
  category: NotificationCategory;
  memberId: string;
  clientRef: string | null;
}): Record<string, unknown> {
  const { notification } = input;
  return {
    v: 1,
    s: input.clientRef,
    u: input.memberId,
    k: PUSH_KIND[input.category],
    nid: notification.id,
    ...(notification.targetType === 'conversation' && notification.targetId ? { sid: notification.targetId } : {}),
    ...(notification.requestId ? { rid: notification.requestId } : {}),
    url: linkPath(notification),
    ...(isRunEnd(notification)
      ? { run: notification.runId, st: notification.kind === 'run_failed' ? 'failed' : 'succeeded' }
      : {}),
  };
}

/** The message for one phone: silent (data only, wakes the app) or a banner. */
export function pushMessage(input: {
  device: { token: string; projectId: string };
  decision: Extract<PushDecision, { send: true }>;
  data: Record<string, unknown>;
  text: { title: string; body: string };
  badge: number;
  /** The phone ends a run's Live Activity as this arrives, even in the background. */
  wake: boolean;
}): PushMessage {
  const base = {
    to: input.device.token,
    projectId: input.device.projectId,
    data: input.data,
    expiration: Math.floor(input.decision.expiresAt / 1000),
  };
  if (input.decision.silent) return { ...base, contentAvailable: true, priority: 'normal' };
  return {
    ...base,
    title: input.text.title,
    body: input.text.body,
    sound: 'default',
    badge: input.badge,
    priority: 'high',
    interruptionLevel: input.decision.interruptionLevel,
    ...(input.wake ? { contentAvailable: true } : {}),
  };
}
