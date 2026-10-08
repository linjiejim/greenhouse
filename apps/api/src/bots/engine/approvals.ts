/**
 * "Needs you" requests — creation, in-turn approval waits and expiry
 * (spec §4–§6, design review R1/R19).
 *
 * One primitive serves every place a Bot needs a person: approvals for
 * Greenhouse writes and vault fills (waited for inside the tool call),
 * secure sign-in and take-over (the turn ends; the hand-back wakes the Bot),
 * and the Bot-creation / background-task proposals (cards the member
 * confirms). Each is a `bot_requests` row; the card binds to its id and is
 * settled exactly once through `db.bots.settleRequest` (CAS on `pending`).
 *
 * Every new request also becomes an in-app notification and a
 * `bots:attention` push, so a member who delegated and walked away still
 * learns their Bot is waiting.
 *
 * Waiters are in-process; a decision made on another API slot is still seen
 * because the waiter also polls the row.
 */

import { getDb, type BotRequestRow, type BotRow, type DatabaseProvider } from '@greenhouse/db';
import type { BotApprovalPayload, BotRequestKind, BotRequestPayload } from '@greenhouse/types/bots';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import { connectionManager } from '../../ws/connection-manager.js';
import { toRequestView } from '../views.js';
import type { ApprovalDecision } from './context.js';
import { copy, type BotsLocale } from './copy.js';

/**
 * The longest an in-turn approval may wait. The spec allows 150 s, but the
 * engine's stream timeout (CHAT_STREAM_TIMEOUT.chunkMs = 120 s) also spans
 * tool execution: a wait past it aborts the whole turn. 110 s leaves headroom.
 */
export const APPROVAL_MAX_WAIT_MS = 110_000;
const APPROVAL_POLL_MS = 2_000;
const EXPIRY_SWEEP_MS = 30_000;

type Waiter = (decision: ApprovalDecision) => void;
const waiters = new Map<string, Waiter>();

/** A short subject line for the event row / notification of a request. */
export function requestSubject(kind: BotRequestKind, payload: BotRequestPayload): string {
  const p = payload as unknown as Record<string, unknown>;
  const pick = (key: string) => (typeof p[key] === 'string' ? (p[key] as string) : '');
  switch (kind) {
    case 'approval':
      // Cards written before 2026-10-08 carry only the title.
      return pick('summary') || pick('title');
    case 'login':
      return pick('origin') || pick('url');
    case 'takeover':
      // An implicit take-over's `reason` is a code (interrupted | waiting), not
      // words; its `title` is page content, which never goes into a line Bots read.
      return p.implicit === true ? pick('host') : pick('reason');
    case 'bot_create':
      return pick('name');
    case 'task_start':
      return pick('title');
    case 'instructions_update':
      return pick('reason');
  }
}

/** The line a new request writes into the transcript (and its notification title). */
export function requestLine(locale: BotsLocale, botName: string, kind: BotRequestKind, payload: BotRequestPayload) {
  const p = payload as unknown as Record<string, unknown>;
  if (kind === 'takeover' && p.implicit === true) {
    const host = typeof p.host === 'string' ? p.host : '';
    return copy.implicitTakeover(locale, botName, p.reason === 'interrupted' ? 'interrupted' : 'waiting', host);
  }
  // The title repeats the Bot's name ("Allow Sage to …?"); the summary names it once.
  if (kind === 'approval' && typeof p.summary === 'string' && p.summary) {
    return copy.approvalLine(locale, botName, p.summary);
  }
  return copy.requestEvent(locale, botName, kind, requestSubject(kind, payload));
}

async function notifyRequest(db: DatabaseProvider, row: BotRequestRow, bot: BotRow | null, locale: BotsLocale) {
  try {
    const result = await db.notifications.createWithStatus({
      user_id: row.user_id,
      kind: 'system',
      // The same line the transcript shows: names the Bot and what it needs.
      title: requestLine(locale, bot?.name ?? 'Bot', row.kind, toRequestView(row).payload).slice(0, 500),
      body: copy.notificationBody(locale),
      payload: {
        bots_session_id: row.session_id,
        bots_request_id: row.id,
        request_kind: row.kind,
        bot_id: row.bot_id,
        href: `#/bots?c=${encodeURIComponent(row.session_id)}`,
      },
      dedupe_key: `bots-request:${row.id}`,
    });
    if (result.created) {
      const unread = await db.notifications.countUnread(row.user_id);
      connectionManager.sendToUser(row.user_id, {
        type: 'notification:new',
        notificationId: result.notification.id,
        kind: result.notification.kind,
        title: result.notification.title,
        unread,
      });
    }
  } catch (error) {
    // The card itself is the source of truth; a lost notification must not fail the tool.
    logger.warn('[bots] could not create the needs-you notification', {
      requestId: row.id,
      error: toErrorMessage(error),
    });
  }
}

export async function pushAttention(db: DatabaseProvider, userId: string): Promise<void> {
  try {
    const pending = await db.bots.countPendingRequests(userId);
    connectionManager.sendToUser(userId, { type: 'bots:attention', pending });
  } catch (error) {
    logger.warn('[bots] attention push failed', { userId, error: toErrorMessage(error) });
  }
}

export interface CreateRequestArgs {
  db?: DatabaseProvider;
  userId: string;
  sessionId: string;
  bot: BotRow | null;
  locale: BotsLocale;
  kind: BotRequestKind;
  payload: BotRequestPayload;
  expiresInMs?: number;
  /** Stream sink for the `bot-request` event (absent outside a running turn). */
  emit?: (event: Record<string, unknown> & { type: string }) => void;
}

/** Persist a request, show its card in the running stream, notify the member. */
export async function createBotRequest(args: CreateRequestArgs): Promise<BotRequestRow> {
  const db = args.db ?? getDb();
  const row = await db.bots.createRequest({
    user_id: args.userId,
    session_id: args.sessionId,
    bot_id: args.bot?.id ?? null,
    kind: args.kind,
    payload: args.payload as unknown as Record<string, unknown>,
    expires_at: args.expiresInMs ? new Date(Date.now() + args.expiresInMs).toISOString() : null,
  });
  args.emit?.({ type: 'bot-request', request: toRequestView(row) });
  // An implicit take-over card exists because the member is at the computer
  // right now; the card and the attention badge are enough.
  const implicit = (args.payload as unknown as Record<string, unknown>).implicit === true;
  if (!implicit) await notifyRequest(db, row, args.bot, args.locale);
  await pushAttention(db, args.userId);
  return row;
}

export interface ApprovalWaitArgs extends Omit<CreateRequestArgs, 'kind' | 'payload' | 'expiresInMs'> {
  payload: BotApprovalPayload;
  timeoutMs?: number;
  signal: AbortSignal;
  /** Background turns: nobody can click, so the answer is always deny. */
  background: boolean;
  /** Called with the persisted row before waiting (e.g. to write the transcript line). */
  onCreated?: (row: BotRequestRow) => Promise<void>;
}

function decisionOf(row: BotRequestRow): ApprovalDecision | null {
  if (row.status === 'pending') return null;
  if (row.status === 'resolved') {
    const result = safeJsonParse(row.result ?? '{}', {}) as { decision?: string };
    return result.decision === 'always' ? 'always' : 'approve';
  }
  if (row.status === 'expired') return 'expired';
  return 'deny';
}

/**
 * Raise an approval card and wait for the member, bounded by the timeout
 * (≤ APPROVAL_MAX_WAIT_MS) and the turn's abort signal. Exactly one outcome:
 * a timeout settles the row as `expired`, an abort as `canceled`.
 */
export async function requestApproval(args: ApprovalWaitArgs): Promise<ApprovalDecision> {
  if (args.background) return 'deny';
  const db = args.db ?? getDb();
  const timeoutMs = Math.min(Math.max(1_000, args.timeoutMs ?? APPROVAL_MAX_WAIT_MS), APPROVAL_MAX_WAIT_MS);
  if (args.signal.aborted) return 'deny';
  const row = await createBotRequest({ ...args, db, kind: 'approval', payload: args.payload, expiresInMs: timeoutMs });
  if (args.onCreated) {
    await args
      .onCreated(row)
      .catch((error) =>
        logger.warn('[bots] approval transcript line failed', { requestId: row.id, error: toErrorMessage(error) }),
      );
  }

  return new Promise<ApprovalDecision>((resolve) => {
    let settled = false;
    const finish = (decision: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      waiters.delete(row.id);
      clearTimeout(timer);
      clearInterval(poll);
      args.signal.removeEventListener('abort', onAbort);
      resolve(decision);
    };
    const settleAs = async (status: 'expired' | 'canceled', decision: ApprovalDecision) => {
      const done = await db.bots.settleRequest(args.userId, row.id, status).catch(() => undefined);
      if (done) {
        finish(decision);
        void pushAttention(db, args.userId);
        return;
      }
      // Lost the race to a real decision — honour it.
      const latest = await db.bots.getRequest(args.userId, row.id).catch(() => undefined);
      finish((latest && decisionOf(latest)) ?? decision);
    };
    const onAbort = () => void settleAs('canceled', 'deny');
    const timer = setTimeout(() => void settleAs('expired', 'expired'), timeoutMs);
    const poll = setInterval(() => {
      void db.bots
        .getRequest(args.userId, row.id)
        .then((latest) => {
          const decision = latest ? decisionOf(latest) : 'deny';
          if (decision) finish(decision);
        })
        .catch(() => undefined);
    }, APPROVAL_POLL_MS);
    timer.unref?.();
    poll.unref?.();
    waiters.set(row.id, finish);
    args.signal.addEventListener('abort', onAbort, { once: true });
    // Aborted while the card was being created: the listener came too late.
    if (args.signal.aborted) onAbort();
  });
}

/** Wake an in-process waiter after the member decided (no-op when none waits here). */
export function resolveApprovalWaiter(requestId: string, decision: ApprovalDecision): void {
  waiters.get(requestId)?.(decision);
}

let expiryTimer: ReturnType<typeof setInterval> | null = null;

/** Expire overdue requests (all kinds) and wake their waiters. */
export async function expireDueRequests(db: DatabaseProvider = getDb()): Promise<BotRequestRow[]> {
  const expired = await db.bots.expireDueRequests();
  const users = new Set<string>();
  for (const row of expired) {
    resolveApprovalWaiter(row.id, 'expired');
    users.add(row.user_id);
    connectionManager.sendToUser(row.user_id, { type: 'bots:conversation', sessionId: row.session_id });
  }
  for (const userId of users) await pushAttention(db, userId);
  return expired;
}

export function startRequestExpiryLoop(): void {
  if (expiryTimer) return;
  expiryTimer = setInterval(() => {
    void expireDueRequests().catch((error) =>
      logger.warn('[bots] request expiry sweep failed', { error: toErrorMessage(error) }),
    );
  }, EXPIRY_SWEEP_MS);
  expiryTimer.unref?.();
}

export function stopRequestExpiryLoop(): void {
  if (expiryTimer) clearInterval(expiryTimer);
  expiryTimer = null;
  for (const finish of [...waiters.values()]) finish('deny');
  waiters.clear();
}
