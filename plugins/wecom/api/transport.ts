import {
  type NotificationTransport,
  automationDeliveryRecipient,
  parseAutomationResultNotificationPayload,
  buildTaskNotification,
} from '@greenhouse/api/extension-kit';
import { sendAppMarkdown } from './client.js';
import { WECOM_PROVIDER } from './oauth.js';
import { sendWeComMarkdown } from './webhook.js';

export const transport: NotificationTransport = {
  id: 'wecom',
  title: 'WeCom',
  sendWebhook: sendWeComMarkdown,
  bindingSettings: { preference: 'wecom', label: 'WeCom' },
  automationResultKeys: ['wecom', 'wecomDm'],
  automationRecipients(task) {
    const recipients: Array<{ recipient: string; resultKey: string }> = [];
    if (task.notify?.wecom)
      recipients.push({ recipient: automationDeliveryRecipient.user('wecom', task.user_id), resultKey: 'wecomDm' });
    if (task.notify?.webhook && this.acceptsWebhook!(new URL(task.notify.webhook)))
      recipients.push({
        recipient: automationDeliveryRecipient.webhook('wecom', task.notify.webhook),
        resultKey: 'wecom',
      });
    return recipients;
  },
  acceptsWebhook: (url) =>
    url.protocol === 'https:' && !url.username && !url.password && url.hostname === 'qyapi.weixin.qq.com',

  async deliver({ db, notification, attempt }) {
    const payload = parseAutomationResultNotificationPayload(notification.payload);
    if (!payload) return { ok: false, error: 'Notification has no supported durable delivery payload' };
    const recipient = automationDeliveryRecipient.parse('wecom', attempt.recipient);
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

    if (attempt.channel === 'wecom' && recipient.kind === 'webhook') {
      const result = await sendWeComMarkdown(recipient.webhook, buildTaskNotification(task, outcome, writes));
      return result.ok
        ? { ok: true }
        : { ok: false, error: result.error ?? `WeCom webhook returned HTTP ${result.status ?? 'unknown'}` };
    }
    if (attempt.channel === 'wecom' && recipient.kind === 'user') {
      if (recipient.userId !== notification.user_id) {
        return { ok: false, error: 'WeCom recipient is not the notification owner' };
      }
      const binding = await db.providerTokens.get(recipient.userId, WECOM_PROVIDER, null);
      if (!binding?.provider_user_id) return { ok: false, error: 'Notification owner has not connected WeCom' };
      return sendAppMarkdown(binding.provider_user_id, buildTaskNotification(task, outcome, writes));
    }
    return { ok: false, error: `Channel ${attempt.channel} does not match its recipient envelope` };
  },
};
