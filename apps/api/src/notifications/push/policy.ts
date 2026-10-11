/**
 * Whether a notification fact becomes a mobile push, which switch governs it and
 * for how long it may still arrive (docs/specs/20261010-mobile-push.md §2.1, §3.4).
 * Pure: `publishNotification` asks once per device when the fact is written, the
 * delivery worker asks again right before sending (prefs and the clock may have
 * moved on).
 *
 * A fact that may become a push carries a `push` envelope in its payload — routing
 * facts only, never content (`PushEnvelope`). Content for a preview is read at
 * send time, from the rows it describes.
 */

import type { BotRequestKind } from '@greenhouse/types/bots';
import type { PushCategory, PushPrefs } from '@greenhouse/types/push';

/** A done / reply push that could not be delivered within a day is no longer news. */
export const PUSH_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** The cards that cannot wait (and may break through Focus): approve, sign in, take over. */
const TIME_SENSITIVE_REQUESTS: ReadonlySet<BotRequestKind> = new Set(['approval', 'login', 'takeover']);

/** Proposals a Bot makes about itself stay in the inbox: nothing waits on them (spec §2.1). */
const MUTED_REQUESTS: ReadonlySet<BotRequestKind> = new Set(['instructions_update']);

const REQUEST_KINDS: ReadonlySet<string> = new Set([
  'takeover',
  'login',
  'approval',
  'bot_create',
  'task_start',
  'instructions_update',
]);

/** What a push needs to route and decide, stored as `payload.push` on the fact. */
export interface PushEnvelope {
  k: PushCategory;
  /** The conversation a tap opens… */
  sid: string;
  /** …and on which surface: a Bots thread, or a chat session (a scheduled task's result). */
  open: 'bots' | 'chat';
  /** needs_you: the card. */
  rid?: string;
  request_kind?: BotRequestKind;
  /** The card's own deadline — a push never outlives the card it asks about. */
  expires_at?: string | null;
  /** The Bot whose name titles the push; absent → the workspace's name. */
  bot_id?: string | null;
  /** replies: the reply. */
  message_id?: string;
  /** done: finished (true) or not (false). */
  ok?: boolean;
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;

/** A stored `payload.push` → the envelope, or null (not one, or malformed). */
export function parsePushEnvelope(value: unknown): PushEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.k !== 'needs_you' && v.k !== 'done' && v.k !== 'replies') return null;
  if (!isText(v.sid) || (v.open !== 'bots' && v.open !== 'chat')) return null;
  if (
    v.k === 'needs_you' &&
    (!isText(v.rid) || typeof v.request_kind !== 'string' || !REQUEST_KINDS.has(v.request_kind))
  )
    return null;
  if (v.k === 'replies' && !isText(v.message_id)) return null;
  const expires = typeof v.expires_at === 'string' && Number.isFinite(Date.parse(v.expires_at)) ? v.expires_at : null;
  return {
    k: v.k,
    sid: v.sid,
    open: v.open,
    ...(isText(v.rid) ? { rid: v.rid } : {}),
    ...(typeof v.request_kind === 'string' && REQUEST_KINDS.has(v.request_kind)
      ? { request_kind: v.request_kind as BotRequestKind }
      : {}),
    ...(v.k === 'needs_you' ? { expires_at: expires } : {}),
    ...(isText(v.bot_id) ? { bot_id: v.bot_id } : {}),
    ...(isText(v.message_id) ? { message_id: v.message_id } : {}),
    ...(typeof v.ok === 'boolean' ? { ok: v.ok } : {}),
  };
}

export type PushDecision =
  | { push: false; reason: 'category_off' | 'muted' | 'expired' }
  | {
      push: true;
      /**
       * No banner, no sound — only wakes the app (`content-available`): a Bot task finished
       * on a device that has "done" pushes off but shows the task as a Live Activity, which
       * the app ends in the background (spec docs/specs/20261010-mobile-live-activity.md §3.4).
       */
      silent: boolean;
      /** Epoch ms after which the push must not arrive (APNs `expiration`). */
      expiresAt: number;
      interruptionLevel: 'time-sensitive' | 'active';
      /** Notification Center groups by conversation, like Messages. */
      threadId: string;
      /** A newer reply in the same conversation replaces the older banner. */
      collapseId?: string;
    };

export function pushPolicy(input: {
  envelope: PushEnvelope;
  prefs: PushPrefs;
  /** The fact's `created_at`. */
  createdAt: string;
  now: number;
}): PushDecision {
  const { envelope, prefs } = input;
  const silent = !prefs[envelope.k] && isBotTaskEnd(envelope) && prefs.live_activity;
  if (!prefs[envelope.k] && !silent) return { push: false, reason: 'category_off' };
  if (envelope.k === 'needs_you' && envelope.request_kind && MUTED_REQUESTS.has(envelope.request_kind)) {
    return { push: false, reason: 'muted' };
  }
  const created = Date.parse(input.createdAt);
  const cardDeadline = envelope.k === 'needs_you' && envelope.expires_at ? Date.parse(envelope.expires_at) : NaN;
  const expiresAt = Number.isFinite(cardDeadline)
    ? cardDeadline
    : (Number.isFinite(created) ? created : input.now) + PUSH_DEFAULT_TTL_MS;
  if (expiresAt <= input.now) return { push: false, reason: 'expired' };
  return {
    push: true,
    silent,
    expiresAt,
    interruptionLevel:
      envelope.k === 'needs_you' && envelope.request_kind && TIME_SENSITIVE_REQUESTS.has(envelope.request_kind)
        ? 'time-sensitive'
        : 'active',
    threadId: `${envelope.open}:${envelope.sid}`,
    ...(envelope.k === 'replies' ? { collapseId: `bots-reply:${envelope.sid}` } : {}),
  };
}

/** A Bot's background task finished — the push a Live Activity on the phone ends on. */
export function isBotTaskEnd(envelope: PushEnvelope): boolean {
  return envelope.k === 'done' && envelope.open === 'bots';
}

/** Where a tap goes — the app's existing deep-link routes (scheme-less; the app owns its scheme). */
export function pushUrl(envelope: PushEnvelope): string {
  if (envelope.open === 'chat') return `/chat/${encodeURIComponent(envelope.sid)}`;
  const request = envelope.rid ? `&request=${encodeURIComponent(envelope.rid)}` : '';
  return `/bots?c=${encodeURIComponent(envelope.sid)}${request}`;
}
