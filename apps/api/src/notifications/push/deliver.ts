/**
 * The delivery worker's `mobile_push` branch.
 *
 * For each leased attempt (one fact × one phone):
 * 1. re-check the phone — gone, disabled, now another account's, registered before
 *    a password reset / suspension, or not seen for 90 days → `suppressed`;
 * 2. re-check the fact — already read, its category switched off on the phone,
 *    older than a day, or (something that waited for the member) no longer pending
 *    → `suppressed`;
 * 3. render in the account's language (no preview unless the phone asked for one)
 *    and send everything to Expo in one pass (grouped by project, ≤100 per request);
 * 4. settle each ticket: accepted → delivered; `DeviceNotRegistered` → the phone is
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
import { pushUrl, type PushData } from '@greenhouse/types/push';
import { getProductName } from '@greenhouse/utils/brand';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';

import { sendExpoPush, type ExpoMessage, type ExpoOutcome, type FetchLike } from './expo.js';
import { pushPolicy } from './policy.js';
import { pushLocale, renderPush, renderTestPush } from './render.js';

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

/** Is the fact still worth a push? A reason when not. */
async function staleReason(db: DatabaseProvider, notification: NotificationRow): Promise<string | null> {
  if (notification.read_at) return 'read';
  if (notification.kind === 'runtime_attention' && notification.interrupt_id) {
    const interrupt = await db.runtime.getInterrupt(notification.interrupt_id);
    if (!interrupt || interrupt.status !== 'pending') return 'interrupt_settled';
  }
  return null;
}

async function prepare(db: DatabaseProvider, attempt: NotificationDeliveryAttemptRow, now: number): Promise<Prepared> {
  const notification = await db.notifications.get(attempt.notification_id);
  if (!notification) return skip('notification_gone');

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
  const decision = pushPolicy({ kind: notification.kind, prefs, createdAt: notification.created_at, now });
  if (!decision.push) return skip(decision.reason);
  const stale = await staleReason(db, notification);
  if (stale) return skip(stale);

  const badge = await db.notifications.countUnread(user.id);
  const { title, body } = renderPush({
    locale: pushLocale(user.locale),
    category: decision.category,
    kind: notification.kind,
    preview: prefs.preview,
    subject: notification.title,
    productName: getProductName(),
  });
  const data: PushData = {
    v: 1,
    s: device.client_ref,
    u: user.id,
    k: decision.category,
    nid: notification.id,
    url: pushUrl(notification.id),
  };
  return {
    kind: 'send',
    deviceId: device.id,
    projectId: device.project_id,
    message: {
      to: device.token,
      title,
      body,
      data: data as unknown as Record<string, unknown>,
      sound: 'default',
      badge,
      priority: 'high',
      expiration: Math.floor(decision.expiresAt / 1000),
      interruptionLevel: decision.interruptionLevel,
      threadId: decision.threadId,
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
      hint: 'UNAUTHORIZED means enhanced push security is on for the Expo project: set EXPO_ACCESS_TOKEN',
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
    logger.error('[push] Expo has no valid APNs / FCM credentials for this app', { attemptId: attempt.id });
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
  const { title, body } = renderTestPush(pushLocale(user.locale), getProductName());
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
