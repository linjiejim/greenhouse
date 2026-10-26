/**
 * Durable optional-channel delivery for permanent platform notifications: the
 * automation channels (WeCom / Feishu / email) one attempt at a time, mobile
 * pushes as one batch per pass (push/deliver.ts — Expo takes ≤100 per request).
 */

import { randomUUID } from 'node:crypto';

import type { DatabaseProvider, NotificationDeliveryAttemptRow, NotificationDeliveryChannel } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { notificationTransports } from './transports.js';
import { deliverPushAttempts } from './push/deliver.js';
import type { FetchLike } from './push/expo.js';

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_BATCH_SIZE = 20;

/** The automation result channels (the Runtime notification projector's half). */
export function automationDeliveryChannels(): readonly NotificationDeliveryChannel[] {
  return notificationTransports().map((t) => t.id);
}

interface DeliveryResult {
  ok: boolean;
  error?: string;
}

export interface NotificationDeliveryWorkerOptions {
  db: DatabaseProvider;
  workerId?: string;
  intervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  skipBootPass?: boolean;
  /**
   * The channels this worker claims (default: the automation channels). The API adds
   * `mobile_push` when `MOBILE_PUSH_ENABLED` is on — never claimed otherwise, so a
   * deployment with pushes off sends nothing to exp.host.
   */
  channels?: readonly NotificationDeliveryChannel[];
  /** Test seam for deterministic backoff timestamps. */
  now?: () => Date;
  /** Test seam for the Expo HTTP client. */
  pushFetch?: FetchLike;
}

export interface NotificationDeliveryWorker {
  runOnce(): Promise<void>;
  stop(): void;
}

export function retryAt(attempts: number, now: Date): string {
  const delayMs = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
  return new Date(now.getTime() + delayMs).toISOString();
}

/**
 * Execute exactly one already-leased attempt.
 *
 * Recipient envelopes are server-generated and deliberately absent from the
 * user-visible notification payload. The user/WeCom binding is resolved at
 * send time so an account connected after the first failure can still make a
 * later retry succeed.
 */
export async function deliverNotificationAttempt(
  db: DatabaseProvider,
  attempt: NotificationDeliveryAttemptRow,
): Promise<DeliveryResult> {
  const notification = await db.notifications.get(attempt.notification_id);
  if (!notification) return { ok: false, error: 'Permanent notification no longer exists' };

  const transport = notificationTransports().find((t) => t.id === attempt.channel);
  return transport
    ? transport.deliver({ db, notification, attempt })
    : { ok: false, error: `Notification transport ${attempt.channel} is disabled` };
}

export async function startNotificationDeliveryWorker(
  options: NotificationDeliveryWorkerOptions,
): Promise<NotificationDeliveryWorker> {
  const { db } = options;
  const workerId = options.workerId ?? `notification-api-${process.pid}-${randomUUID().slice(0, 8)}`;
  const leaseMs = Math.max(options.leaseMs ?? DEFAULT_LEASE_MS, 1_000);
  const batchSize = Math.min(Math.max(options.batchSize ?? DEFAULT_BATCH_SIZE, 1), 100);
  const channels = [...(options.channels ?? automationDeliveryChannels())];
  const now = options.now ?? (() => new Date());
  let running = false;
  let stopped = false;

  const processAttempt = async (attempt: NotificationDeliveryAttemptRow): Promise<void> => {
    try {
      const result = await deliverNotificationAttempt(db, attempt);
      if (result.ok) {
        await db.notifications.acknowledgeDelivery({
          id: attempt.id,
          expected_version: attempt.version,
          worker_id: workerId,
          at: now(),
        });
        return;
      }
      const failed = await db.notifications.failDelivery({
        id: attempt.id,
        expected_version: attempt.version,
        worker_id: workerId,
        error: result.error ?? 'Notification delivery failed',
        at: now(),
        retry_at: retryAt(attempt.attempts, now()),
      });
      if (failed.status === 'dead_letter') {
        logger.error('[notification-delivery] attempt reached dead letter', {
          attemptId: attempt.id,
          notificationId: attempt.notification_id,
          channel: attempt.channel,
          error: result.error ?? 'Notification delivery failed',
        });
      }
    } catch (error) {
      // Network functions can throw before returning their structured result.
      // Return the lease to the durable queue when it is still ours. If the
      // lease was lost, the next claimer is already authoritative.
      try {
        const failed = await db.notifications.failDelivery({
          id: attempt.id,
          expected_version: attempt.version,
          worker_id: workerId,
          error: toErrorMessage(error),
          at: now(),
          retry_at: retryAt(attempt.attempts, now()),
        });
        if (failed.status === 'dead_letter') {
          logger.error('[notification-delivery] thrown attempt reached dead letter', {
            attemptId: attempt.id,
            notificationId: attempt.notification_id,
            channel: attempt.channel,
            error: toErrorMessage(error),
          });
        }
      } catch (leaseError) {
        logger.warn('[notification-delivery] could not settle attempt after delivery error', {
          attemptId: attempt.id,
          notificationId: attempt.notification_id,
          channel: attempt.channel,
          error: toErrorMessage(leaseError),
        });
      }
    }
  };

  const runOnce = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const attempts = await db.notifications.claimDeliveries({
        worker_id: workerId,
        lease_ms: leaseMs,
        channels,
        limit: batchSize,
        at: now(),
      });
      const pushes = attempts.filter((attempt) => attempt.channel === 'mobile_push');
      const others = attempts.filter((attempt) => attempt.channel !== 'mobile_push');
      // Start every claimed network request promptly so a slow first channel
      // cannot let a later row's lease expire before it even begins.
      await Promise.all([
        ...others.map(processAttempt),
        deliverPushAttempts(pushes, { db, workerId, now, retryAt, fetch: options.pushFetch }),
      ]);
    } finally {
      running = false;
    }
  };

  if (!options.skipBootPass) await runOnce();
  const timer = setInterval(
    () => void runOnce().catch((error) => logger.error('[notification-delivery] worker pass failed', { error })),
    Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, 250),
  );
  timer.unref();

  return {
    runOnce,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
