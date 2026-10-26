import { transport as emailTransport } from '../../../email/api/transport.js';
import { transport as wecomTransport } from '../transport.js';
import { transport as feishuTransport } from '../../../feishu/api/transport.js';
import { registerNotificationTransports } from '../../../../apps/api/src/notifications/transports.js';
registerNotificationTransports([wecomTransport, feishuTransport, emailTransport]);
/**
 * The notify_webhook whitelist is what keeps that field from being a "POST the
 * run summary anywhere" channel, so its exact shape is pinned: two hosts, and
 * for Feishu additionally the fixed bot path. `notifyWebhookKind` then decides
 * which payload format the delivery worker speaks — a WeCom body POSTed to a
 * Feishu hook (or vice versa) fails silently at the far end.
 */

import { describe, expect, it } from 'vitest';
import { validateNotifyWebhook } from '../../../../apps/api/src/scheduler/task-center.js';
import { notificationWebhookTransport } from '../../../../apps/api/src/notifications/transports.js';

describe('validateNotifyWebhook', () => {
  it('accepts the two group-bot families and nothing else', () => {
    expect(validateNotifyWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k')).toBeNull();
    expect(validateNotifyWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/abc-123')).toBeNull();

    // Feishu host outside the bot path is an API surface, not a webhook.
    expect(validateNotifyWebhook('https://open.feishu.cn/open-apis/im/v1/messages')).not.toBeNull();
    expect(validateNotifyWebhook('https://example.com/webhook')).not.toBeNull();
    expect(validateNotifyWebhook('http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k')).not.toBeNull();
    expect(validateNotifyWebhook('not a url')).not.toBeNull();
  });

  it('treats empty as "no webhook", not an error', () => {
    expect(validateNotifyWebhook(null)).toBeNull();
    expect(validateNotifyWebhook(undefined)).toBeNull();
    expect(validateNotifyWebhook('')).toBeNull();
  });
});

describe('notifyWebhookKind', () => {
  it('routes each validated family to its payload format', () => {
    expect(notificationWebhookTransport('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k')?.id).toBe('wecom');
    expect(notificationWebhookTransport('https://open.feishu.cn/open-apis/bot/v2/hook/abc-123')?.id).toBe('feishu');
  });
});
