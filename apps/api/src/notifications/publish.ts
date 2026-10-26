import { getDb, type DatabaseProvider } from '@greenhouse/db';
import { queueMobilePush } from './push/queue.js';
import { connectionManager } from '../ws/connection-manager.js';

/** Registered notification kind + durable inbox + mobile/WS delivery; no second notification path. */
export async function notify(
  input: Parameters<DatabaseProvider['notifications']['createWithStatus']>[0],
  db = getDb(),
) {
  const result = await db.notifications.createWithStatus(input);
  await queueMobilePush(db, result.notification);
  if (result.created)
    connectionManager.sendToUser(result.notification.user_id, {
      type: 'notification:new',
      notificationId: result.notification.id,
      kind: result.notification.kind,
      title: result.notification.title,
      unread: await db.notifications.countUnread(result.notification.user_id),
      runId: result.notification.run_id,
      interruptId: result.notification.interrupt_id,
    });
  return result.notification;
}
