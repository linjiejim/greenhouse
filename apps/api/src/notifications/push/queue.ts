/**
 * `queueMobilePush()` — the push half of writing a notification fact. Every
 * producer calls it right after `db.notifications.createWithStatus()` (the Runtime
 * projector, scheduled-task results); a new producer must too, or its facts never
 * reach a phone.
 *
 * It writes one `mobile_push` delivery row per phone that may receive the fact now
 * (deliverable, and its switch for the fact's category on). Rows are written on
 * replays too — each is unique per fact × phone, so a crash between the fact and
 * its rows heals on retry. With pushes off for the deployment it writes nothing.
 * The delivery worker sends them (./deliver.ts).
 *
 * Never throws: a failure here must not fail the producer, whose fact is already
 * the truth in the in-app center.
 */

import { pushDevicePrefs, type DatabaseProvider, type NotificationRow } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';

import { mobilePushEnabled } from './config.js';
import { pushPolicy } from './policy.js';

export interface QueuePushOptions {
  /** Test seam; default `MOBILE_PUSH_ENABLED`. */
  enabled?: boolean;
  now?: () => number;
}

/** Returns how many deliveries were queued. */
export async function queueMobilePush(
  db: DatabaseProvider,
  notification: NotificationRow,
  options: QueuePushOptions = {},
): Promise<number> {
  if (!(options.enabled ?? mobilePushEnabled())) return 0;
  // An already-read fact (a replay long after the member saw it) is no news.
  if (notification.read_at) return 0;
  try {
    const user = await db.users.getById(notification.user_id);
    if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) return 0;
    const now = (options.now ?? Date.now)();
    const devices = await db.pushDevices.listDeliverable(user, now);
    let queued = 0;
    for (const device of devices) {
      const decision = pushPolicy({
        kind: notification.kind,
        prefs: pushDevicePrefs(device),
        createdAt: notification.created_at,
        now,
      });
      if (!decision.push) continue;
      await db.notifications.createDelivery({
        notification_id: notification.id,
        channel: 'mobile_push',
        recipient: device.id,
      });
      queued += 1;
    }
    return queued;
  } catch (error) {
    logger.warn('[push] could not queue mobile pushes', {
      notificationId: notification.id,
      error: toErrorMessage(error),
    });
    return 0;
  }
}
