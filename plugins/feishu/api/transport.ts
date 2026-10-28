import {
  type NotificationTransport,
  automationDeliveryRecipient,
  parseAutomationResultNotificationPayload,
  buildTaskNotification,
} from '@greenhouse/api/extension-kit';
import { sendCardMarkdown } from './client.js';
import { FEISHU_PROVIDER } from './oauth.js';
import { sendFeishuMarkdown } from './webhook.js';

export const transport: NotificationTransport = {
  id: 'feishu',
  title: 'Feishu',
  sendWebhook: sendFeishuMarkdown,
  bindingSettings: { preference: 'feishu', label: 'Feishu' },
  automationResultKeys: ['feishuDm'],
  automationRecipients(task) {
    const recipients: Array<{ recipient: string; resultKey: string }> = [];
    if (task.notify?.feishu)
      recipients.push({ recipient: automationDeliveryRecipient.user('feishu', task.user_id), resultKey: 'feishuDm' });
    if (task.notify?.webhook && this.acceptsWebhook!(new URL(task.notify.webhook)))
      recipients.push({
        recipient: automationDeliveryRecipient.webhook('feishu', task.notify.webhook),
        resultKey: 'wecom',
      });
    return recipients;
  },
  acceptsWebhook: (url) =>
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    url.hostname === 'open.feishu.cn' &&
    url.pathname.startsWith('/open-apis/bot/'),

  async deliver({ db, notification, attempt }) {
    const payload = parseAutomationResultNotificationPayload(notification.payload);
    if (!payload) return { ok: false, error: 'Notification has no supported durable delivery payload' };
    const recipient = automationDeliveryRecipient.parse('feishu', attempt.recipient);
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

    if (attempt.channel === 'feishu' && recipient.kind === 'webhook') {
      const result = await sendFeishuMarkdown(recipient.webhook, buildTaskNotification(task, outcome, writes));
      return result.ok
        ? { ok: true }
        : { ok: false, error: result.error ?? `Feishu webhook returned HTTP ${result.status ?? 'unknown'}` };
    }
    if (attempt.channel === 'feishu' && recipient.kind === 'user') {
      if (recipient.userId !== notification.user_id) {
        return { ok: false, error: 'Feishu recipient is not the notification owner' };
      }
      const binding = await db.providerTokens.get(recipient.userId, FEISHU_PROVIDER, null);
      if (!binding?.provider_user_id) return { ok: false, error: 'Notification owner has not connected Feishu' };
      return sendCardMarkdown(binding.provider_user_id, buildTaskNotification(task, outcome, writes));
    }
    return { ok: false, error: `Channel ${attempt.channel} does not match its recipient envelope` };
  },
};
