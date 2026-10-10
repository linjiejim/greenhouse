/**
 * `publishNotification()` — the one way a producer writes a notification fact
 * (docs/specs/20261010-mobile-push.md §3.4 ①). Bot cards (bots/engine/approvals.ts),
 * missed Bot replies (bots/engine/reply-alerts.ts), Runtime terminal events
 * (runtime-projector.ts) and scheduled-task results (scheduler/notify.ts) all go
 * through it:
 *
 * 1. the permanent fact, idempotent per `(user_id, dedupe_key)` — a replay whose
 *    wording moved on (the account switched language between two attempts) reuses
 *    the fact already written instead of failing forever;
 * 2. a newly created fact is announced over WS (`notification:new`);
 * 3. a fact with a `push` envelope gets one `mobile_push` delivery row per device
 *    that may receive it (`pushPolicy` — its switch, its deadline), unless the
 *    deployment has pushes off. Rows are written on replays too (each is unique per
 *    fact × device), so a crash between the fact and its rows heals on retry.
 *
 * Errors propagate: a Runtime projector retries its event, a tool that must not
 * fail catches. A failed WS announcement never does — the fact is the truth.
 */

import {
  NotificationError,
  type CreateNotificationInput,
  type DatabaseProvider,
  type NotificationRow,
} from '@greenhouse/db';
import { pushDevicePrefs } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';

import { connectionManager } from '../ws/connection-manager.js';
import { mobilePushEnabled } from './push/config.js';
import { parsePushEnvelope, pushPolicy, type PushEnvelope } from './push/policy.js';

export interface PublishNotificationInput extends Omit<CreateNotificationInput, 'payload'> {
  payload?: Record<string, unknown>;
  /** Where a push for this fact routes; absent = never a push (inbox + WS only). */
  push?: PushEnvelope;
}

export interface PublishOptions {
  /** Test seam; default `MOBILE_PUSH_ENABLED`. */
  pushEnabled?: boolean;
  now?: () => number;
}

async function writeFact(
  db: DatabaseProvider,
  input: CreateNotificationInput,
): Promise<{ notification: NotificationRow; created: boolean }> {
  try {
    return await db.notifications.createWithStatus(input);
  } catch (error) {
    if (!(error instanceof NotificationError) || error.code !== 'notification_idempotency_conflict') throw error;
    const existing = await db.notifications.getByDedupeKey(input.user_id, input.dedupe_key);
    if (!existing) throw error;
    logger.warn('[notifications] a replay changed its wording; keeping the fact already written', {
      notificationId: existing.id,
      kind: existing.kind,
    });
    return { notification: existing, created: false };
  }
}

/** One `mobile_push` row per device this fact may reach now. Returns how many were queued. */
async function queuePush(
  db: DatabaseProvider,
  notification: NotificationRow,
  envelope: PushEnvelope,
  now: number,
): Promise<number> {
  const user = await db.users.getById(notification.user_id);
  if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) return 0;
  const devices = await db.pushDevices.listDeliverable(user, now);
  let queued = 0;
  for (const device of devices) {
    const decision = pushPolicy({ envelope, prefs: pushDevicePrefs(device), createdAt: notification.created_at, now });
    if (!decision.push) continue;
    await db.notifications.createDelivery({
      notification_id: notification.id,
      channel: 'mobile_push',
      recipient: device.id,
    });
    queued += 1;
  }
  return queued;
}

export async function publishNotification(
  db: DatabaseProvider,
  input: PublishNotificationInput,
  options: PublishOptions = {},
): Promise<{ notification: NotificationRow; created: boolean }> {
  const { push, ...fact } = input;
  const result = await writeFact(db, {
    ...fact,
    payload: push ? { ...(fact.payload ?? {}), push } : (fact.payload ?? {}),
  });

  if (result.created) {
    try {
      const unread = await db.notifications.countUnread(result.notification.user_id);
      connectionManager.sendToUser(result.notification.user_id, {
        type: 'notification:new',
        notificationId: result.notification.id,
        kind: result.notification.kind,
        title: result.notification.title,
        unread,
        runId: result.notification.run_id,
        interruptId: result.notification.interrupt_id,
      });
    } catch (error) {
      logger.warn('[notifications] could not announce a new notification', {
        notificationId: result.notification.id,
        error: toErrorMessage(error),
      });
    }
  }

  if (push && (options.pushEnabled ?? mobilePushEnabled())) {
    // The worker reads the stored envelope: a replay of a fact written without one (or with an
    // older one) queues nothing it could not deliver.
    const stored = parsePushEnvelope((safeJsonParse(result.notification.payload, {}) as { push?: unknown }).push);
    if (stored) await queuePush(db, result.notification, stored, (options.now ?? Date.now)());
  }
  return result;
}
