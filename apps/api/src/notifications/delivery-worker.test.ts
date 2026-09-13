import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider, NotificationDeliveryAttemptRow, NotificationRow } from '@greenhouse/db';

const mocks = vi.hoisted(() => ({
  sendWebhook: vi.fn(),
  sendEmail: vi.fn(),
  sendWeComDm: vi.fn(),
}));

vi.mock('@greenhouse/utils/wecom', () => ({ sendWeComMarkdown: mocks.sendWebhook }));
vi.mock('../email/service.js', () => ({ sendFromSharedMailbox: mocks.sendEmail }));
vi.mock('../wecom/client.js', () => ({ sendAppMarkdown: mocks.sendWeComDm }));
vi.mock('../routes/wecom-oauth.js', () => ({ WECOM_PROVIDER: 'wecom' }));

import { deliverNotificationAttempt, startNotificationDeliveryWorker } from './delivery-worker.js';

const NOW = '2026-08-12T08:00:00.000Z';

function notification(): NotificationRow {
  return {
    id: 'ntf-automation-1',
    user_id: 'owner-1',
    kind: 'runtime_completed',
    title: 'Daily report completed',
    body: 'All good',
    payload: JSON.stringify({
      schema: 1,
      type: 'automation_result',
      task_id: 42,
      task_name: 'Daily report',
      session_id: 'session-1',
      status: 'completed',
      summary: 'All good',
    }),
    run_id: null,
    interrupt_id: null,
    event_id: null,
    agent_id: null,
    dedupe_key: 'automation-result:42:session-1:completed',
    read_at: null,
    created_at: NOW,
  };
}

function attempt(
  recipient: string,
  channel: NotificationDeliveryAttemptRow['channel'],
  id = `delivery-${channel}`,
): NotificationDeliveryAttemptRow {
  return {
    id,
    notification_id: 'ntf-automation-1',
    channel,
    recipient,
    status: 'claimed',
    attempts: 1,
    max_attempts: 5,
    available_at: NOW,
    lease_owner: 'worker-1',
    lease_expires_at: '2026-08-12T08:02:00.000Z',
    last_error: null,
    delivered_at: null,
    created_at: NOW,
    updated_at: NOW,
    version: 2,
  };
}

function deliveryDb(overrides: Record<string, unknown> = {}): DatabaseProvider {
  return {
    notifications: {
      get: vi.fn().mockResolvedValue(notification()),
      claimDeliveries: vi.fn().mockResolvedValue([]),
      acknowledgeDelivery: vi.fn(),
      failDelivery: vi.fn(),
      ...overrides,
    },
    users: {
      getById: vi.fn().mockResolvedValue({ id: 'owner-1', email: 'owner@example.test', nickname: 'Owner' }),
    },
    providerTokens: {
      get: vi.fn().mockResolvedValue({ provider_user_id: 'wecom-owner' }),
    },
  } as unknown as DatabaseProvider;
}

describe('notification delivery worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendWebhook.mockResolvedValue({ ok: true, status: 200 });
    mocks.sendEmail.mockResolvedValue({ ok: true, messageId: 'mail-1' });
    mocks.sendWeComDm.mockResolvedValue({ ok: true });
  });

  it('routes server-authored recipient envelopes without exposing destination choice to the payload', async () => {
    const db = deliveryDb();

    await expect(
      deliverNotificationAttempt(
        db,
        attempt('wecom:webhook:https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret', 'wecom'),
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      deliverNotificationAttempt(db, attempt('wecom:user:owner-1', 'wecom', 'delivery-dm')),
    ).resolves.toEqual({ ok: true });
    await expect(deliverNotificationAttempt(db, attempt('email:user:owner-1', 'email'))).resolves.toEqual({
      ok: true,
      messageId: 'mail-1',
    });

    expect(mocks.sendWebhook).toHaveBeenCalledWith(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret',
      expect.stringContaining('Daily report'),
    );
    expect(mocks.sendWeComDm).toHaveBeenCalledWith('wecom-owner', expect.stringContaining('All good'));
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      db,
      { address: 'owner@example.test', name: 'Owner' },
      expect.objectContaining({ subject: '✅ Daily report' }),
      { userId: 'owner-1', origin: 'automation', sessionId: 'session-1', taskId: 42 },
    );
  });

  it('claims and acknowledges successful delivery with the leased version', async () => {
    const row = attempt('wecom:user:owner-1', 'wecom');
    const acknowledgeDelivery = vi.fn().mockResolvedValue({ ...row, status: 'delivered', version: 3 });
    const db = deliveryDb({
      claimDeliveries: vi.fn().mockResolvedValue([row]),
      acknowledgeDelivery,
    });
    const worker = await startNotificationDeliveryWorker({
      db,
      workerId: 'worker-1',
      skipBootPass: true,
      intervalMs: 60_000,
      now: () => new Date(NOW),
    });

    await worker.runOnce();
    worker.stop();

    expect(db.notifications.claimDeliveries).toHaveBeenCalledWith({
      worker_id: 'worker-1',
      lease_ms: 120_000,
      channels: ['wecom', 'feishu', 'email'],
      limit: 20,
      at: new Date(NOW),
    });
    expect(acknowledgeDelivery).toHaveBeenCalledWith({
      id: row.id,
      expected_version: row.version,
      worker_id: 'worker-1',
      at: new Date(NOW),
    });
  });

  it('drains pending deliveries during startup and stops cleanly', async () => {
    const row = attempt('email:user:owner-1', 'email');
    const acknowledgeDelivery = vi.fn().mockResolvedValue({ ...row, status: 'delivered', version: 3 });
    const claimDeliveries = vi.fn().mockResolvedValueOnce([row]).mockResolvedValue([]);
    const db = deliveryDb({ claimDeliveries, acknowledgeDelivery });

    const worker = await startNotificationDeliveryWorker({
      db,
      workerId: 'boot-worker',
      intervalMs: 60_000,
      now: () => new Date(NOW),
    });
    worker.stop();

    expect(claimDeliveries).toHaveBeenCalledTimes(1);
    expect(acknowledgeDelivery).toHaveBeenCalledWith({
      id: row.id,
      expected_version: row.version,
      worker_id: 'boot-worker',
      at: new Date(NOW),
    });
  });

  it('returns transient failures to the durable queue with exponential backoff', async () => {
    mocks.sendWebhook.mockResolvedValue({ ok: false, status: 503, error: 'upstream unavailable' });
    const row = attempt('wecom:webhook:https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret', 'wecom');
    const failDelivery = vi.fn().mockResolvedValue({ ...row, status: 'pending', attempts: 1, version: 3 });
    const acknowledgeDelivery = vi.fn();
    const db = deliveryDb({
      claimDeliveries: vi.fn().mockResolvedValue([row]),
      acknowledgeDelivery,
      failDelivery,
    });
    const worker = await startNotificationDeliveryWorker({
      db,
      workerId: 'worker-1',
      skipBootPass: true,
      intervalMs: 60_000,
      now: () => new Date(NOW),
    });

    await worker.runOnce();
    worker.stop();

    expect(acknowledgeDelivery).not.toHaveBeenCalled();
    expect(failDelivery).toHaveBeenCalledWith({
      id: row.id,
      expected_version: row.version,
      worker_id: 'worker-1',
      error: 'upstream unavailable',
      at: new Date(NOW),
      retry_at: '2026-08-12T08:00:05.000Z',
    });
  });
});
