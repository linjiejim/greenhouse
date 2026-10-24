/**
 * Mobile push end to end against real PostgreSQL: a producer writes the fact →
 * one `mobile_push` row per deliverable phone → the delivery worker re-checks,
 * renders in the account's language without content, sends to a fake exp.host and
 * settles each ticket. Also: a fact read before the worker runs is suppressed, a
 * phone that switched the category off gets nothing, `DeviceNotRegistered` disables
 * the phone, previews show only the title, and with `MOBILE_PUSH_ENABLED=false`
 * nothing is queued at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  _resetProvider,
  initDatabase,
  type DatabaseProvider,
  type NotificationDeliveryAttemptRow,
  type ScheduledTaskRow,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { parsePushData } from '@greenhouse/types/push';

import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import { notifyTaskResult } from '../../../scheduler/notify.js';
import { startNotificationDeliveryWorker } from '../../delivery-worker.js';
import type { ExpoMessage, FetchLike } from '../expo.js';
import { queueMobilePush } from '../queue.js';

vi.mock('../../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));

const PROJECT = '1f49365d-7d88-472a-b196-01fcd9c428e5';
let db: DatabaseProvider;
let member: UserRow;
const originalSwitch = process.env.MOBILE_PUSH_ENABLED;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A fake exp.host: records every message, answers each with `ticket(message)`. */
function fakeExpo(ticket: (message: ExpoMessage) => unknown = () => ({ status: 'ok', id: unique('ticket') })) {
  const sent: ExpoMessage[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const batch = JSON.parse(init.body) as ExpoMessage[];
    sent.push(...batch);
    return { status: 200, json: async () => ({ data: batch.map(ticket) }), text: async () => '' };
  };
  return { sent, fetchImpl };
}

async function runWorker(fetchImpl: FetchLike): Promise<void> {
  const worker = await startNotificationDeliveryWorker({
    db,
    channels: ['mobile_push'],
    skipBootPass: true,
    intervalMs: 60_000,
    pushFetch: fetchImpl,
  });
  try {
    await worker.runOnce();
  } finally {
    worker.stop();
  }
}

async function attemptsFor(userId: string): Promise<NotificationDeliveryAttemptRow[]> {
  return (await db.executeRaw(sql`
    SELECT a.* FROM notification_deliveries a
    JOIN notifications n ON n.id = a.notification_id
    WHERE n.user_id = ${userId} AND a.channel = 'mobile_push'
    ORDER BY a.created_at
  `)) as NotificationDeliveryAttemptRow[];
}

async function registerPhone(prefs: Record<string, boolean> = {}) {
  return (
    await db.pushDevices.register({
      user_id: member.id,
      token: `ExponentPushToken[${unique('phone')}]`,
      platform: 'ios',
      project_id: PROJECT,
      client_ref: 'st-home',
      prefs,
      auth_version: member.auth_version,
    })
  ).device;
}

async function fact(kind: 'runtime_attention' | 'runtime_completed' | 'runtime_failed' | 'system', title: string) {
  const { notification } = await db.notifications.createWithStatus({
    user_id: member.id,
    kind,
    title,
    body: 'Private details that never leave the server.',
    dedupe_key: unique('fact'),
  });
  return notification;
}

beforeEach(async () => {
  delete process.env.MOBILE_PUSH_ENABLED;
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  member = await createInternalTestUser(db, { email: `${unique('push-pipeline')}@test.local` });
  await db.users.update(member.id, { locale: 'zh' });
});

afterEach(async () => {
  if (originalSwitch === undefined) delete process.env.MOBILE_PUSH_ENABLED;
  else process.env.MOBILE_PUSH_ENABLED = originalSwitch;
  await db.close();
  _resetProvider();
});

describe('a notification reaches the phone', () => {
  it('as a content-free push in the account language, routed to the notification', async () => {
    const phone = await registerPhone();
    const notification = await fact('system', '季度报告已上传');
    expect(await queueMobilePush(db, notification)).toBe(1);
    // a replay queues nothing new: one row per fact × phone
    expect(await queueMobilePush(db, notification)).toBe(1);
    expect(await attemptsFor(member.id)).toHaveLength(1);

    const expo = fakeExpo();
    await runWorker(expo.fetchImpl);

    expect(expo.sent).toHaveLength(1);
    const [message] = expo.sent;
    expect(message).toMatchObject({
      to: phone.token,
      title: 'Greenhouse',
      body: '你有一条新通知',
      badge: 1,
      sound: 'default',
      interruptionLevel: 'active',
    });
    expect(JSON.stringify(message)).not.toContain('季度报告');
    expect(JSON.stringify(message)).not.toContain('Private details');
    expect(parsePushData(message!.data)).toEqual({
      v: 1,
      s: 'st-home',
      u: member.id,
      k: 'other',
      nid: notification.id,
      url: `/notification?id=${notification.id}`,
    });
    const [attempt] = await attemptsFor(member.id);
    expect(attempt).toMatchObject({ status: 'delivered', recipient: phone.id });
  });

  it('from a scheduled task result, with only the title when the phone shows previews', async () => {
    await registerPhone({ preview: true });
    const task = { id: unique('task'), name: '日报', user_id: member.id } as unknown as ScheduledTaskRow;
    await notifyTaskResult(db, task, { status: 'completed', summary: '今天一切正常', sessionId: unique('session') });

    const expo = fakeExpo();
    await runWorker(expo.fetchImpl);
    expect(expo.sent).toHaveLength(1);
    expect(expo.sent[0]).toMatchObject({ body: '日报 completed' });
    expect(parsePushData(expo.sent[0]!.data)?.k).toBe('done');
    expect(JSON.stringify(expo.sent[0])).not.toContain('今天一切正常');
  });

  it('suppresses a push whose notification was read before the worker ran', async () => {
    await registerPhone();
    const notification = await fact('runtime_completed', 'Run completed');
    await queueMobilePush(db, notification);
    await db.notifications.markRead(notification.id, member.id);

    const expo = fakeExpo();
    await runWorker(expo.fetchImpl);
    expect(expo.sent).toHaveLength(0);
    expect((await attemptsFor(member.id))[0]).toMatchObject({ status: 'suppressed', last_error: 'read' });
  });

  it('queues nothing for a phone that switched the category off, and re-checks the switch before sending', async () => {
    const quiet = await registerPhone({ done: false });
    expect(await queueMobilePush(db, await fact('runtime_failed', 'Run needs review'))).toBe(0);

    const loud = await registerPhone();
    await queueMobilePush(db, await fact('runtime_failed', 'Run needs review'));
    await db.pushDevices.updatePrefs(member.id, loud.id, { done: false });
    const expo = fakeExpo();
    await runWorker(expo.fetchImpl);
    expect(expo.sent).toHaveLength(0);
    const attempts = await attemptsFor(member.id);
    expect(attempts.map((a) => a.recipient)).toEqual([loud.id]);
    expect(attempts[0]).toMatchObject({ status: 'suppressed', last_error: 'category_off' });
    expect(quiet.disabled_at).toBeNull();
  });

  it('disables a phone Expo no longer knows and fails the attempt for good', async () => {
    const phone = await registerPhone();
    await queueMobilePush(db, await fact('system', 'Hello'));
    const expo = fakeExpo(() => ({
      status: 'error',
      message: 'not registered',
      details: { error: 'DeviceNotRegistered' },
    }));
    await runWorker(expo.fetchImpl);
    expect((await attemptsFor(member.id))[0]).toMatchObject({ status: 'failed', last_error: 'DeviceNotRegistered' });
    expect(await db.pushDevices.get(phone.id)).toMatchObject({ disabled_reason: 'device_not_registered' });
  });

  it('puts a transient refusal back on the queue with backoff', async () => {
    await registerPhone();
    await queueMobilePush(db, await fact('system', 'Hello'));
    const fetchImpl: FetchLike = async () => ({ status: 503, json: async () => ({}), text: async () => '' });
    await runWorker(fetchImpl);
    const [attempt] = await attemptsFor(member.id);
    expect(attempt).toMatchObject({ status: 'pending', attempts: 1 });
    expect(Date.parse(attempt!.available_at)).toBeGreaterThan(Date.now());
  });

  it('stops reaching a phone registered before a password reset', async () => {
    await registerPhone();
    await queueMobilePush(db, await fact('system', 'Hello'));
    await db.executeRaw(sql`UPDATE users SET auth_version = auth_version + 1 WHERE id = ${member.id}`);
    const expo = fakeExpo();
    await runWorker(expo.fetchImpl);
    expect(expo.sent).toHaveLength(0);
    expect((await attemptsFor(member.id))[0]).toMatchObject({ status: 'suppressed', last_error: 'device_unavailable' });
  });

  it('queues nothing when the deployment has pushes off', async () => {
    await registerPhone();
    process.env.MOBILE_PUSH_ENABLED = 'false';
    expect(await queueMobilePush(db, await fact('system', 'Hello'))).toBe(0);
    expect(await attemptsFor(member.id)).toEqual([]);
  });
});
