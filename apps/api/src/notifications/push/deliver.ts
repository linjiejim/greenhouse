/**
 * The delivery worker's `mobile_push` branch (docs/specs/20261010-mobile-push.md §3.4 ③).
 *
 * For each leased attempt (one fact × one device):
 * 1. re-check the device — gone, disabled, now another account's, registered before
 *    a password reset / suspension, or not seen for 90 days → `suppressed`;
 * 2. re-check the event — its switch is off now, the account lost Bots, the card was
 *    decided or expired, the reply was read (or a card is waiting in that
 *    conversation) → `suppressed`;
 * 3. render in the account's language and send everything to Expo in one pass
 *    (grouped by project, ≤100 per request). A Bot task's "done" push also names the
 *    run and how it ended (`run` / `st`) and, for a device that shows tasks as Live
 *    Activities, wakes the app (`contentAvailable`) — as a silent push when the device
 *    has "done" pushes off (spec docs/specs/20261010-mobile-live-activity.md §3.4);
 * 4. settle each ticket: accepted → delivered; `DeviceNotRegistered` → the device is
 *    disabled and the attempt `failed`; `MessageRateExceeded`, 429, 5xx, network →
 *    the worker's backoff; a refused request or `MessageTooBig` → dead letter
 *    (logged as an error — it is a bug or a broken deployment, not weather).
 */

import type {
  DatabaseProvider,
  NotificationDeliveryAttemptRow,
  NotificationRow,
  PushDeviceRow,
  UserRow,
} from '@greenhouse/db';
import { isDeliverable, pushDevicePrefs } from '@greenhouse/db';
import type { BotRequestPayload } from '@greenhouse/types/bots';
import type { PushData, PushTaskOutcome } from '@greenhouse/types/push';
import { getProductName } from '@greenhouse/utils/brand';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';

import { userHasFeature } from '../../auth/features.js';
import { requestSubject } from '../../bots/engine/approvals.js';
import { botsLocale } from '../../bots/engine/copy.js';
import { sendExpoPush, type ExpoMessage, type ExpoOutcome, type FetchLike } from './expo.js';
import { isBotTaskEnd, parsePushEnvelope, pushPolicy, pushUrl, type PushEnvelope } from './policy.js';
import { renderPush, renderTestPush } from './render.js';

/** How long a test push may wait for the phone. */
const TEST_PUSH_TTL_S = 5 * 60;

export interface PushDeliveryDeps {
  db: DatabaseProvider;
  workerId: string;
  now: () => Date;
  /** The worker's backoff schedule (attempt n → retry time). */
  retryAt: (attempts: number, now: Date) => string;
  /** Test seam for the HTTP client. */
  fetch?: FetchLike;
}

type Prepared =
  | { kind: 'skip'; status: 'suppressed' | 'dead_letter'; reason: string }
  /** A read failed on the way (the database blinked): back to the queue with the usual backoff. */
  | { kind: 'retry'; error: string }
  | { kind: 'send'; deviceId: string; projectId: string; message: ExpoMessage };

const skip = (reason: string, status: 'suppressed' | 'dead_letter' = 'suppressed'): Prepared => ({
  kind: 'skip',
  status,
  reason,
});

/** Is the event still worth a push? A reason when not. */
async function staleReason(
  db: DatabaseProvider,
  userId: string,
  envelope: PushEnvelope,
  now: number,
): Promise<string | null> {
  if (envelope.k === 'needs_you') {
    const request = await db.bots.getRequest(userId, envelope.rid ?? '');
    if (!request || request.status !== 'pending') return 'request_settled';
    if (request.expires_at && Date.parse(request.expires_at) <= now) return 'request_expired';
    return null;
  }
  if (envelope.k === 'replies') {
    const [conversation, message, pending] = await Promise.all([
      db.bots.getConversation(userId, envelope.sid),
      db.sessions.getMessageById(envelope.message_id ?? ''),
      db.bots.listRequests(userId, { sessionId: envelope.sid, status: 'pending' }),
    ]);
    if (!conversation || !message || message.session_id !== envelope.sid) return 'reply_gone';
    if (conversation.last_read_at && Date.parse(conversation.last_read_at) >= Date.parse(message.created_at)) {
      return 'reply_read';
    }
    // One signal per conversation: a waiting card already called the member.
    if (pending.length > 0) return 'needs_you_pending';
    return null;
  }
  return null;
}

/** The preview's subject and excerpt (read only when the device shows previews). */
async function previewContent(
  db: DatabaseProvider,
  notification: NotificationRow,
  envelope: PushEnvelope,
): Promise<{ subject: string | null; excerpt: string | null }> {
  const payload = safeJsonParse(notification.payload, {}) as Record<string, unknown>;
  const text = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string) : null);
  if (envelope.k === 'needs_you' && envelope.rid) {
    const request = await db.bots.getRequest(notification.user_id, envelope.rid);
    if (!request) return { subject: null, excerpt: null };
    const requestPayload = safeJsonParse(request.payload, {}) as BotRequestPayload;
    return { subject: requestSubject(request.kind, requestPayload) || null, excerpt: null };
  }
  if (envelope.k === 'replies' && envelope.message_id) {
    const message = await db.sessions.getMessageById(envelope.message_id);
    return { subject: null, excerpt: message?.content ?? null };
  }
  if (envelope.open === 'chat') return { subject: text('task_name'), excerpt: text('summary') };
  return { subject: text('task_title'), excerpt: null };
}

/** A Bot task's run and how it ended, from its terminal fact (runtime-projector.ts: `run_id`, `payload.status`). */
function botTaskEnd(notification: NotificationRow): { run: string; st: PushTaskOutcome } | null {
  const status = (safeJsonParse(notification.payload, {}) as { status?: unknown }).status;
  if (!notification.run_id || (status !== 'succeeded' && status !== 'failed' && status !== 'interrupted')) return null;
  return { run: notification.run_id, st: status };
}

async function prepare(db: DatabaseProvider, attempt: NotificationDeliveryAttemptRow, now: number): Promise<Prepared> {
  const notification = await db.notifications.get(attempt.notification_id);
  if (!notification) return skip('notification_gone');
  const envelope = parsePushEnvelope((safeJsonParse(notification.payload, {}) as { push?: unknown }).push);
  if (!envelope) return skip('no_push_envelope', 'dead_letter');

  const [device, user] = await Promise.all([
    db.pushDevices.get(attempt.recipient),
    db.users.getById(notification.user_id),
  ]);
  if (!device) return skip('device_gone');
  if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) {
    return skip('account_inactive');
  }
  if (!isDeliverable(device, user, now)) return skip('device_unavailable');

  const prefs = pushDevicePrefs(device);
  const decision = pushPolicy({ envelope, prefs, createdAt: notification.created_at, now });
  if (!decision.push) return skip(decision.reason);
  if (envelope.open === 'bots' && !(await userHasFeature(user.id, user.role, 'bots', db))) return skip('bots_off');
  const stale = await staleReason(db, user.id, envelope, now);
  if (stale) return skip(stale);

  const task = isBotTaskEnd(envelope) ? botTaskEnd(notification) : null;
  const data: PushData = {
    v: 1,
    s: device.client_ref,
    u: user.id,
    k: envelope.k,
    sid: envelope.sid,
    ...(envelope.rid ? { rid: envelope.rid } : {}),
    nid: notification.id,
    url: pushUrl(envelope),
    ...(task ? { run: task.run, st: task.st } : {}),
  };
  if (decision.silent) {
    // Only there to end a Live Activity: nothing to end without the run.
    if (!task) return skip('no_task_run');
    return {
      kind: 'send',
      deviceId: device.id,
      projectId: device.project_id,
      message: {
        to: device.token,
        data: data as unknown as Record<string, unknown>,
        contentAvailable: true,
        priority: 'normal',
        expiration: Math.floor(decision.expiresAt / 1000),
      },
    };
  }

  const [bot, content, badge] = await Promise.all([
    envelope.bot_id ? db.bots.getBot(user.id, envelope.bot_id) : Promise.resolve(undefined),
    prefs.preview ? previewContent(db, notification, envelope) : Promise.resolve({ subject: null, excerpt: null }),
    db.bots.attentionCount(user.id),
  ]);
  const { title, body } = renderPush({
    locale: botsLocale(user.locale),
    envelope,
    preview: prefs.preview,
    botName: bot?.name ?? null,
    fallbackTitle: getProductName(),
    subject: content.subject,
    excerpt: content.excerpt,
  });
  return {
    kind: 'send',
    deviceId: device.id,
    projectId: device.project_id,
    message: {
      to: device.token,
      title,
      body,
      data: data as unknown as Record<string, unknown>,
      // the phone ends the task's Live Activity as this arrives, even with the app in the background
      ...(task && prefs.live_activity ? { contentAvailable: true } : {}),
      sound: 'default',
      badge,
      priority: 'high',
      expiration: Math.floor(decision.expiresAt / 1000),
      interruptionLevel: decision.interruptionLevel,
      threadId: decision.threadId,
      ...(decision.collapseId ? { collapseId: decision.collapseId } : {}),
    },
  };
}

/** Settle one leased attempt; a lost lease means another worker owns it now — nothing to do. */
async function settle(
  deps: PushDeliveryDeps,
  attempt: NotificationDeliveryAttemptRow,
  outcome: Prepared | ExpoOutcome,
) {
  const { db, workerId } = deps;
  const at = deps.now();
  const lease = { id: attempt.id, expected_version: attempt.version, worker_id: workerId, at };
  const terminal = (status: 'suppressed' | 'failed' | 'dead_letter', reason: string) =>
    db.notifications.settleDelivery({ ...lease, status, reason });
  const retry = (error: string) =>
    db.notifications.failDelivery({ ...lease, error, retry_at: deps.retryAt(attempt.attempts, at) });

  if ('kind' in outcome) {
    if (outcome.kind === 'skip') {
      if (outcome.status === 'dead_letter') {
        logger.error('[push] attempt cannot be rendered', { attemptId: attempt.id, reason: outcome.reason });
      }
      await terminal(outcome.status, outcome.reason);
    } else if (outcome.kind === 'retry') {
      await retry(outcome.error);
    }
    return;
  }
  if (outcome.status === 'ok') {
    await db.notifications.acknowledgeDelivery(lease);
    return;
  }
  if (outcome.status === 'retry') {
    const failed = await retry(outcome.error);
    if (failed.status === 'dead_letter') {
      logger.error('[push] attempt reached dead letter', { attemptId: attempt.id, error: outcome.error });
    }
    return;
  }
  if (outcome.status === 'fatal') {
    logger.error('[push] exp.host refused the request', {
      attemptId: attempt.id,
      error: outcome.error,
      hint: 'UNAUTHORIZED means enhanced push security is on for the Expo project; it must stay off',
    });
    await terminal('dead_letter', outcome.error);
    return;
  }
  // A per-message refusal.
  if (outcome.code === 'DeviceNotRegistered') {
    await db.pushDevices.disable(attempt.recipient, 'device_not_registered');
    await terminal('failed', 'DeviceNotRegistered');
    return;
  }
  if (outcome.code === 'MessageTooBig') {
    logger.error('[push] message too big — a rendering bug', { attemptId: attempt.id });
    await terminal('dead_letter', 'MessageTooBig');
    return;
  }
  if (outcome.code === 'InvalidCredentials') {
    logger.error('[push] Expo has no valid APNs credentials for this app', {
      attemptId: attempt.id,
      hint: 'see docs/specs/20261010-mobile-push.md §6 (a dedicated APNs key)',
    });
  }
  const failed = await retry(`${outcome.code ?? 'error'}: ${outcome.message}`);
  if (failed.status === 'dead_letter') {
    logger.error('[push] attempt reached dead letter', {
      attemptId: attempt.id,
      error: outcome.code ?? outcome.message,
    });
  }
}

/** Deliver a batch of leased `mobile_push` attempts. Never throws. */
export async function deliverPushAttempts(
  attempts: readonly NotificationDeliveryAttemptRow[],
  deps: PushDeliveryDeps,
): Promise<void> {
  if (attempts.length === 0) return;
  const now = deps.now().getTime();
  const prepared = await Promise.all(
    attempts.map(async (attempt): Promise<Prepared> => {
      try {
        return await prepare(deps.db, attempt, now);
      } catch (error) {
        return { kind: 'retry', error: toErrorMessage(error) };
      }
    }),
  );

  const sendable = prepared
    .map((item, index) => ({ item, attempt: attempts[index]! }))
    .filter(
      (entry): entry is { item: Extract<Prepared, { kind: 'send' }>; attempt: NotificationDeliveryAttemptRow } =>
        entry.item.kind === 'send',
    );
  const outcomes = sendable.length
    ? await sendExpoPush(
        sendable.map(({ item }) => ({ projectId: item.projectId, message: item.message })),
        deps.fetch,
      ).catch((error): ExpoOutcome[] =>
        sendable.map(() => ({ status: 'retry', error: toErrorMessage(error) }) satisfies ExpoOutcome),
      )
    : [];

  const settlements: Array<Promise<unknown>> = [];
  prepared.forEach((item, index) => {
    if (item.kind !== 'send') settlements.push(settle(deps, attempts[index]!, item));
  });
  sendable.forEach(({ attempt }, index) => settlements.push(settle(deps, attempt, outcomes[index]!)));

  const results = await Promise.allSettled(settlements);
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn('[push] could not settle an attempt', { error: toErrorMessage(result.reason) });
    }
  }
}

/**
 * The settings page's "send a test" (`POST /api/auth/me/push-devices/:id/test`): one
 * message straight to Expo, outside the queue, so a self-hoster sees at once whether
 * exp.host is reachable from the server. Returns Expo's verdict.
 */
export async function sendTestPush(
  device: Pick<PushDeviceRow, 'token' | 'project_id' | 'client_ref'>,
  user: Pick<UserRow, 'id' | 'locale'>,
  fetchImpl?: FetchLike,
): Promise<ExpoOutcome> {
  const { title, body } = renderTestPush(botsLocale(user.locale), getProductName());
  const data: PushData = { v: 1, s: device.client_ref, u: user.id, k: 'test', nid: 'test' };
  const [outcome] = await sendExpoPush(
    [
      {
        projectId: device.project_id,
        message: {
          to: device.token,
          title,
          body,
          data: data as unknown as Record<string, unknown>,
          sound: 'default',
          priority: 'high',
          expiration: Math.floor(Date.now() / 1000) + TEST_PUSH_TTL_S,
        },
      },
    ],
    fetchImpl,
  );
  return outcome ?? { status: 'retry', error: 'no outcome' };
}
