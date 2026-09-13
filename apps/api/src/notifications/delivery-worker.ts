/** Durable optional-channel delivery for permanent platform notifications. */

import { randomUUID } from 'node:crypto';

import type { DatabaseProvider, NotificationDeliveryAttemptRow } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';
import { sendWeComMarkdown } from '@greenhouse/utils/wecom';
import { sendFeishuMarkdown } from '@greenhouse/utils/feishu';

import { sendFromSharedMailbox } from '../email/service.js';
import { WECOM_PROVIDER } from '../routes/wecom-oauth.js';
import {
  automationDeliveryRecipient,
  buildTaskEmail,
  buildTaskNotification,
  parseAutomationResultNotificationPayload,
} from '../scheduler/notify.js';
import { sendAppMarkdown } from '../wecom/client.js';
import { sendCardMarkdown } from '../feishu/client.js';
import { FEISHU_PROVIDER } from '../routes/feishu-oauth.js';

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_BATCH_SIZE = 20;

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
  /** Test seam for deterministic backoff timestamps. */
  now?: () => Date;
}

export interface NotificationDeliveryWorker {
  runOnce(): Promise<void>;
  stop(): void;
}

function retryAt(attempts: number, now: Date): string {
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

  const payload = parseAutomationResultNotificationPayload(safeJsonParse(notification.payload, null));
  if (!payload) return { ok: false, error: 'Notification has no supported durable delivery payload' };
  const recipient = automationDeliveryRecipient.parse(attempt.recipient);
  if (!recipient) return { ok: false, error: 'Notification delivery recipient envelope is invalid' };
  const task = { name: payload.task_name };
  const outcome = {
    status: payload.status,
    summary: payload.summary,
    sessionId: payload.session_id,
  };
  // The write receipt travels in the payload, so every channel and every retry
  // renders the same facts without re-querying Runtime.
  const writes = payload.writes;

  if (attempt.channel === 'wecom' && recipient.kind === 'wecom_webhook') {
    const result = await sendWeComMarkdown(recipient.webhook, buildTaskNotification(task, outcome, writes));
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.error ?? `WeCom webhook returned HTTP ${result.status ?? 'unknown'}` };
  }

  if (attempt.channel === 'feishu' && recipient.kind === 'feishu_webhook') {
    const result = await sendFeishuMarkdown(recipient.webhook, buildTaskNotification(task, outcome, writes));
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.error ?? `Feishu webhook returned HTTP ${result.status ?? 'unknown'}` };
  }

  if (attempt.channel === 'feishu' && recipient.kind === 'feishu_user') {
    if (recipient.userId !== notification.user_id) {
      return { ok: false, error: 'Feishu recipient is not the notification owner' };
    }
    const binding = await db.providerTokens.get(recipient.userId, FEISHU_PROVIDER, null);
    if (!binding?.provider_user_id) return { ok: false, error: 'Notification owner has not connected Feishu' };
    return sendCardMarkdown(binding.provider_user_id, buildTaskNotification(task, outcome, writes));
  }

  if (attempt.channel === 'wecom' && recipient.kind === 'wecom_user') {
    if (recipient.userId !== notification.user_id) {
      return { ok: false, error: 'WeCom recipient is not the notification owner' };
    }
    const binding = await db.providerTokens.get(recipient.userId, WECOM_PROVIDER, null);
    if (!binding?.provider_user_id) return { ok: false, error: 'Notification owner has not connected WeCom' };
    return sendAppMarkdown(binding.provider_user_id, buildTaskNotification(task, outcome, writes));
  }

  if (attempt.channel === 'email' && recipient.kind === 'email_user') {
    if (recipient.userId !== notification.user_id) {
      return { ok: false, error: 'Email recipient is not the notification owner' };
    }
    const owner = await db.users.getById(recipient.userId);
    if (!owner?.email) return { ok: false, error: 'Notification owner has no usable email address' };
    return sendFromSharedMailbox(
      db,
      { address: owner.email, name: owner.nickname ?? undefined },
      buildTaskEmail(task, outcome, writes),
      {
        userId: notification.user_id,
        origin: 'automation',
        sessionId: payload.session_id,
        taskId: payload.task_id,
      },
    );
  }

  return { ok: false, error: `Channel ${attempt.channel} does not match its recipient envelope` };
}

export async function startNotificationDeliveryWorker(
  options: NotificationDeliveryWorkerOptions,
): Promise<NotificationDeliveryWorker> {
  const { db } = options;
  const workerId = options.workerId ?? `notification-api-${process.pid}-${randomUUID().slice(0, 8)}`;
  const leaseMs = Math.max(options.leaseMs ?? DEFAULT_LEASE_MS, 1_000);
  const batchSize = Math.min(Math.max(options.batchSize ?? DEFAULT_BATCH_SIZE, 1), 100);
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
        channels: ['wecom', 'feishu', 'email'],
        limit: batchSize,
        at: now(),
      });
      // Start every claimed network request promptly so a slow first channel
      // cannot let a later row's lease expire before it even begins.
      await Promise.all(attempts.map(processAttempt));
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
