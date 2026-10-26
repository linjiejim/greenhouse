import {
  type NotificationTransport,
  automationDeliveryRecipient,
  parseAutomationResultNotificationPayload,
  buildTaskEmail,
} from '@greenhouse/api/extension-kit';
import { sendFromSharedMailbox, getSharedMailboxCredentials } from './service.js';

export const transport: NotificationTransport = {
  id: 'email',
  title: 'Email',
  bindingSettings: { preference: 'email', label: 'Email' },
  automationResultKeys: ['email'],
  automationRecipients(task) {
    const recipients: Array<{ recipient: string; resultKey: string }> = [];
    if (task.notify?.email)
      recipients.push({ recipient: automationDeliveryRecipient.user('email', task.user_id), resultKey: 'email' });

    return recipients;
  },

  accountLinks: {
    available: () => !!getSharedMailboxCredentials(),
    send: ({ db, recipient, message, actorId }) =>
      sendFromSharedMailbox(db, recipient, message, { userId: actorId, origin: 'account-security' }),
  },
  async deliver({ db, notification, attempt }) {
    const payload = parseAutomationResultNotificationPayload(notification.payload);
    if (!payload) return { ok: false, error: 'Notification has no supported durable delivery payload' };
    const recipient = automationDeliveryRecipient.parse('email', attempt.recipient);
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

    if (attempt.channel === 'email' && recipient.kind === 'user') {
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
  },
};
