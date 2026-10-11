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
  'tables_plan',
]);

/** The Tables notification a `record` / `app` push stands for (its words). */
export type PushTablesSource = 'automation' | 'mention';

/** What a push needs to route and decide, stored as `payload.push` on the fact. */
export interface PushEnvelope {
  k: PushCategory;
  /** The conversation a tap opens (`bots` / `chat`; absent for `record` / `app`)… */
  sid?: string;
  /**
   * …and on which surface: a Bots thread, a chat session (a scheduled task's result), a
   * Tables record, or a record / page of an app (Tables → Apps Phase 1).
   */
  open: 'bots' | 'chat' | 'record' | 'app';
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
  /** record / app: which Tables notification (automation notice, comment mention). */
  source?: PushTablesSource;
  /** record: the record's Base. */
  base_id?: number;
  /** record (required) / app: the record's table. */
  table_id?: number;
  /** record / app: the record (a record-less scheduled automation names only its table). */
  record_id?: number;
  /** app: the app the member reaches the record through. */
  app_id?: number;
  /** app: the page to open. */
  page_id?: string;
  /** mention: who wrote the comment — their name titles the push. */
  actor_id?: string;
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;

const isRowId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const PAGE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** The record / app half of an envelope, or null when the stored one is malformed. */
function parseTablesTarget(v: Record<string, unknown>): Partial<PushEnvelope> | null {
  if (v.source !== 'automation' && v.source !== 'mention') return null;
  if (v.open === 'record' && !(isRowId(v.base_id) && isRowId(v.table_id))) return null;
  if (v.open === 'app' && !isRowId(v.app_id)) return null;
  for (const key of ['base_id', 'table_id', 'record_id', 'app_id']) {
    if (v[key] !== undefined && !isRowId(v[key])) return null;
  }
  if (v.page_id !== undefined && (typeof v.page_id !== 'string' || !PAGE_ID.test(v.page_id))) return null;
  return {
    source: v.source,
    ...(isRowId(v.base_id) ? { base_id: v.base_id } : {}),
    ...(isRowId(v.table_id) ? { table_id: v.table_id } : {}),
    ...(isRowId(v.record_id) ? { record_id: v.record_id } : {}),
    ...(isRowId(v.app_id) ? { app_id: v.app_id } : {}),
    ...(typeof v.page_id === 'string' ? { page_id: v.page_id } : {}),
    ...(isText(v.actor_id) ? { actor_id: v.actor_id } : {}),
  };
}

/** A Tables push (`record` / `app`) — not a conversation. */
export function isTablesPush(envelope: PushEnvelope): boolean {
  return envelope.open === 'record' || envelope.open === 'app';
}

/** A stored `payload.push` → the envelope, or null (not one, or malformed). */
export function parsePushEnvelope(value: unknown): PushEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.k !== 'needs_you' && v.k !== 'done' && v.k !== 'replies') return null;
  if (v.open === 'record' || v.open === 'app') {
    const target = parseTablesTarget(v);
    return target ? { k: v.k, open: v.open, ...target } : null;
  }
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

/**
 * The envelope of a Tables notification (Tables → Apps Phase 1, spec
 * docs/specs/20261011-mobile-tables-apps.md §3): an automation's notice is "needs you"
 * when the rule marks it urgent and "done" otherwise; a comment mention is a reply. It
 * opens where the recipient reads the record — the Tables route, or the app they reach it
 * through (`canRecipientRead`'s `via`).
 */
export function tablesPushEnvelope(input: {
  source: PushTablesSource;
  urgent?: boolean;
  baseId: number;
  tableId: number;
  recordId?: number | null;
  /** How the recipient reads the record (`canRecipientRead`): an app → its runtime. */
  appId?: number | null;
  actorId?: string | null;
}): PushEnvelope {
  const k: PushCategory = input.source === 'mention' ? 'replies' : input.urgent ? 'needs_you' : 'done';
  const record = input.recordId && input.recordId > 0 ? { record_id: input.recordId } : {};
  const actor = input.actorId ? { actor_id: input.actorId } : {};
  if (input.appId) {
    return { k, open: 'app', source: input.source, app_id: input.appId, table_id: input.tableId, ...record, ...actor };
  }
  return {
    k,
    open: 'record',
    source: input.source,
    base_id: input.baseId,
    table_id: input.tableId,
    ...record,
    ...actor,
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
  // An urgent Tables automation is what its rule says it is: it may break through Focus too.
  const timeSensitive =
    envelope.k === 'needs_you' &&
    (isTablesPush(envelope) || (!!envelope.request_kind && TIME_SENSITIVE_REQUESTS.has(envelope.request_kind)));
  return {
    push: true,
    silent,
    expiresAt,
    interruptionLevel: timeSensitive ? 'time-sensitive' : 'active',
    threadId: threadKey(envelope),
    ...(envelope.k === 'replies' && !isTablesPush(envelope) ? { collapseId: `bots-reply:${envelope.sid}` } : {}),
  };
}

/** Notification Center's grouping: a conversation, or a record (an app page without one). */
function threadKey(envelope: PushEnvelope): string {
  if (envelope.open === 'record') return `record:${envelope.table_id}:${envelope.record_id ?? 'table'}`;
  if (envelope.open === 'app') {
    return `app:${envelope.app_id}:${envelope.record_id ? `${envelope.table_id ?? ''}:${envelope.record_id}` : (envelope.page_id ?? 'home')}`;
  }
  return `${envelope.open}:${envelope.sid}`;
}

/** A Bot's background task finished — the push a Live Activity on the phone ends on. */
export function isBotTaskEnd(envelope: PushEnvelope): boolean {
  return envelope.k === 'done' && envelope.open === 'bots';
}

/** Where a tap goes — the app's existing deep-link routes (scheme-less; the app owns its scheme). */
export function pushUrl(envelope: PushEnvelope): string {
  if (envelope.open === 'record') {
    const where = `tableId=${envelope.table_id}&baseId=${envelope.base_id}`;
    return envelope.record_id
      ? `/tables/record/${envelope.record_id}?${where}`
      : `/tables/table/${envelope.table_id}?baseId=${envelope.base_id}`;
  }
  if (envelope.open === 'app') {
    const query = [
      ...(envelope.record_id ? [`record=${envelope.record_id}`] : []),
      ...(envelope.record_id && envelope.table_id ? [`table=${envelope.table_id}`] : []),
      ...(envelope.page_id ? [`page=${encodeURIComponent(envelope.page_id)}`] : []),
    ].join('&');
    return `/apps/${envelope.app_id}${query ? `?${query}` : ''}`;
  }
  const sid = encodeURIComponent(envelope.sid ?? '');
  if (envelope.open === 'chat') return `/chat/${sid}`;
  const request = envelope.rid ? `&request=${encodeURIComponent(envelope.rid)}` : '';
  return `/bots?c=${sid}${request}`;
}
