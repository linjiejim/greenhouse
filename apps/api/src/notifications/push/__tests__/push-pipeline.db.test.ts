/**
 * Mobile push end to end against real PostgreSQL (docs/specs/20261010-mobile-push.md
 * §3.4): a producer writes the fact → one `mobile_push` row per deliverable device →
 * the delivery worker re-checks, renders in the account's language, sends to a fake
 * exp.host and settles each ticket. Also: a card decided before the worker runs is
 * suppressed, `DeviceNotRegistered` disables the device, a missed reply becomes an
 * alert (once) whose preview follows the device switch, and with
 * `MOBILE_PUSH_ENABLED=false` nothing is queued at all. A Bot task's end names its run
 * and outcome and wakes a phone that shows the task as a Live Activity — silently when
 * that phone has "done" pushes off (docs/specs/20261010-mobile-live-activity.md §3.4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  _resetProvider,
  initDatabase,
  type BotRow,
  type DatabaseProvider,
  type NotificationDeliveryAttemptRow,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { parsePushData } from '@greenhouse/types/push';

import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import { createBotRequest } from '../../../bots/engine/approvals.js';
import { sweepReplyAlerts } from '../../../bots/engine/reply-alerts.js';
import { startNotificationDeliveryWorker } from '../../delivery-worker.js';
import { publishNotification } from '../../publish.js';
import type { ExpoMessage, FetchLike } from '../expo.js';

vi.mock('../../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));

const PROJECT = '1f49365d-7d88-472a-b196-01fcd9c428e5';
let db: DatabaseProvider;
let member: UserRow;
let bot: BotRow;
let sid: string;
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

async function attemptsFor(notificationUserId: string): Promise<NotificationDeliveryAttemptRow[]> {
  return (await db.executeRaw(sql`
    SELECT a.* FROM notification_delivery_attempts a
    JOIN notifications n ON n.id = a.notification_id
    WHERE n.user_id = ${notificationUserId} AND a.channel = 'mobile_push'
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

beforeEach(async () => {
  delete process.env.MOBILE_PUSH_ENABLED;
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  member = await createInternalTestUser(db, { email: `${unique('push-pipeline')}@test.local` });
  await db.users.update(member.id, { locale: 'zh' });
  bot = await db.bots.createBot({ user_id: member.id, name: 'Sage' });
  sid = (await db.bots.ensureDirectConversation(member.id, bot.id)).session_id;
});

afterEach(() => {
  if (originalSwitch === undefined) delete process.env.MOBILE_PUSH_ENABLED;
  else process.env.MOBILE_PUSH_ENABLED = originalSwitch;
  _resetProvider();
});

describe('a Bot card reaches the phone', () => {
  it('as a time-sensitive, content-free push in the account language, routed to the card', async () => {
    const phone = await registerPhone();
    const card = await createBotRequest({
      db,
      userId: member.id,
      sessionId: sid,
      bot,
      locale: 'zh',
      kind: 'approval',
      payload: { title: '允许 Sage 发送邮件？', summary: '发送邮件给 王总', fields: [] } as never,
      expiresInMs: 110_000,
    });
    const [queued] = await attemptsFor(member.id);
    expect(queued).toMatchObject({ recipient: phone.id, status: 'pending' });

    const expo = fakeExpo();
    await runWorker(expo.fetchImpl);

    expect(expo.sent).toHaveLength(1);
    const message = expo.sent[0]!;
    expect(message).toMatchObject({
      to: phone.token,
      title: 'Sage',
      body: '请你批准一个操作',
      sound: 'default',
      badge: 1,
      interruptionLevel: 'time-sensitive',
      threadId: `bots:${sid}`,
      expiration: Math.floor(Date.parse(card.expires_at!) / 1000),
    });
    expect(JSON.stringify(message)).not.toContain('王总');
    const data = parsePushData(message.data);
    expect(data).toEqual({
      v: 1,
      s: 'st-home',
      u: member.id,
      k: 'needs_you',
      sid,
      rid: card.id,
      nid: queued!.notification_id,
      url: `/bots?c=${encodeURIComponent(sid)}&request=${card.id}`,
    });
    expect(JSON.stringify(message.data).length).toBeLessThan(1024);
    const [settled] = await attemptsFor(member.id);
    expect(settled).toMatchObject({ status: 'delivered' });
  });

  it('shows the subject when the device asks for previews', async () => {
    await registerPhone({ preview: true });
    await createBotRequest({
      db,
      userId: member.id,
      sessionId: sid,
      bot,
      locale: 'zh',
      kind: 'login',
      payload: { origin: 'https://example.com', url: 'https://example.com/login' } as never,
      expiresInMs: 60 * 60_000,
    });
    const expo = fakeExpo();
    await runWorker(expo.fetchImpl);
    expect(expo.sent[0]?.body).toBe('需要你登录 https://example.com');
  });

  it('is suppressed when the card was decided before the worker got to it', async () => {
    await registerPhone();
    const card = await createBotRequest({
      db,
      userId: member.id,
      sessionId: sid,
      bot,
      locale: 'zh',
      kind: 'bot_create',
      payload: { name: '小润', role: '写手' } as never,
    });
    await db.bots.settleRequest(member.id, card.id, 'denied');
    const expo = fakeExpo();
    await runWorker(expo.fetchImpl);
    expect(expo.sent).toEqual([]);
    expect((await attemptsFor(member.id))[0]).toMatchObject({ status: 'suppressed', last_error: 'request_settled' });
  });

  it('disables a phone the app was removed from (DeviceNotRegistered)', async () => {
    const phone = await registerPhone();
    await createBotRequest({
      db,
      userId: member.id,
      sessionId: sid,
      bot,
      locale: 'zh',
      kind: 'task_start',
      payload: { title: '竞品调研', brief: '查三家' } as never,
    });
    const expo = fakeExpo(() => ({ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }));
    await runWorker(expo.fetchImpl);
    expect((await attemptsFor(member.id))[0]).toMatchObject({ status: 'failed', last_error: 'DeviceNotRegistered' });
    expect(await db.pushDevices.get(phone.id)).toMatchObject({ disabled_reason: 'device_not_registered' });
  });

  it('queues nothing when the deployment has pushes off', async () => {
    process.env.MOBILE_PUSH_ENABLED = 'false';
    await registerPhone();
    await createBotRequest({
      db,
      userId: member.id,
      sessionId: sid,
      bot,
      locale: 'zh',
      kind: 'approval',
      payload: { title: 't', summary: 's', fields: [] } as never,
      expiresInMs: 110_000,
    });
    expect(await attemptsFor(member.id)).toEqual([]);
  });

  it('never queues for a device registered before a password reset', async () => {
    await registerPhone();
    await db.users.resetPasswordAndRevokeSessions(member.id, 'not-a-real-hash');
    await createBotRequest({
      db,
      userId: member.id,
      sessionId: sid,
      bot,
      locale: 'zh',
      kind: 'approval',
      payload: { title: 't', summary: 's', fields: [] } as never,
      expiresInMs: 110_000,
    });
    expect(await attemptsFor(member.id)).toEqual([]);
  });
});

describe('a missed reply reaches the phone once', () => {
  async function replyAndLeave(content: string): Promise<string> {
    await db.sessions.addMessage({ session_id: sid, role: 'user', content: '帮我找三家供应商' });
    const reply = await db.sessions.addMessage({ session_id: sid, role: 'assistant', content, bot_id: bot.id });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await db.bots.touchActivity(sid);
    return reply.id;
  }

  it('alerts after a minute, with the first words only when the device shows previews', async () => {
    const plain = await registerPhone();
    const preview = await registerPhone({ preview: true });
    const replyId = await replyAndLeave('找到了三家供应商：**甲**、乙、丙。');

    expect(await sweepReplyAlerts(db, Date.now() + 2 * 60_000)).toBe(1);
    // the next sweep finds the alert already written
    expect(await sweepReplyAlerts(db, Date.now() + 2 * 60_000)).toBe(0);
    const fact = await db.notifications.getByDedupeKey(member.id, `bots-reply:${sid}:${replyId}`);
    expect(fact).toMatchObject({ kind: 'bots_reply', title: 'Sage 回复了你', body: '打开对话查看。' });

    const expo = fakeExpo();
    await runWorker(expo.fetchImpl);
    const byPhone = new Map(expo.sent.map((m) => [m.to, m]));
    expect(byPhone.get(plain.token)).toMatchObject({
      title: 'Sage',
      body: '回复了你',
      collapseId: `bots-reply:${sid}`,
    });
    expect(byPhone.get(preview.token)?.body).toBe('找到了三家供应商：甲、乙、丙。');
  });

  it('is suppressed when the member read it on another client before the worker ran', async () => {
    await registerPhone();
    await replyAndLeave('好的。');
    await sweepReplyAlerts(db, Date.now() + 2 * 60_000);
    await db.bots.markRead(member.id, sid);
    const expo = fakeExpo();
    await runWorker(expo.fetchImpl);
    expect(expo.sent).toEqual([]);
    expect((await attemptsFor(member.id))[0]).toMatchObject({ status: 'suppressed', last_error: 'reply_read' });
  });
});

describe("a Bot task's end reaches the phone that shows it as a Live Activity", () => {
  /** The fact the Runtime projector writes when a Bot task ends (runtime-projector.ts). */
  async function taskEnded(runId: string, status: 'succeeded' | 'failed' | 'interrupted') {
    await publishNotification(db, {
      user_id: member.id,
      kind: status === 'succeeded' ? 'runtime_completed' : 'runtime_failed',
      title: '后台任务完成了：检查链接',
      body: 'Bot 已在对话里汇报。',
      payload: { runtime_kind: 'subagent', source_id: 'bottask-test', status, bots_session_id: sid, bot_id: bot.id },
      run_id: runId,
      dedupe_key: `runtime-terminal:${runId}:${status}:1`,
      push: { k: 'done', sid, open: 'bots', bot_id: bot.id, ok: status === 'succeeded' },
    });
  }

  it('names the run and how it ended, and wakes the app only where Live Activities are on', async () => {
    const plain = await registerPhone();
    const live = await registerPhone({ live_activity: true });
    await taskEnded('rtm_task_la_1', 'succeeded');

    const expo = fakeExpo();
    await runWorker(expo.fetchImpl);

    expect(expo.sent).toHaveLength(2);
    const toLive = expo.sent.find((message) => message.to === live.token)!;
    const toPlain = expo.sent.find((message) => message.to === plain.token)!;
    expect(toLive).toMatchObject({ title: 'Sage', body: '后台任务完成了', contentAvailable: true });
    expect(toPlain).toMatchObject({ title: 'Sage', body: '后台任务完成了' });
    expect(toPlain).not.toHaveProperty('contentAvailable');
    for (const message of [toLive, toPlain]) {
      expect(parsePushData(message.data)).toMatchObject({ k: 'done', sid, run: 'rtm_task_la_1', st: 'succeeded' });
    }
  });

  it('is a silent push for a phone with "done" pushes off that shows tasks as Live Activities', async () => {
    const live = await registerPhone({ done: false, live_activity: true });
    await registerPhone({ done: false });
    await taskEnded('rtm_task_la_2', 'failed');

    // the phone without Live Activities gets no row at all
    expect((await attemptsFor(member.id)).map((attempt) => attempt.recipient)).toEqual([live.id]);

    const expo = fakeExpo();
    await runWorker(expo.fetchImpl);

    expect(expo.sent).toEqual([
      {
        to: live.token,
        data: expect.objectContaining({ k: 'done', run: 'rtm_task_la_2', st: 'failed' }),
        contentAvailable: true,
        priority: 'normal',
        expiration: expect.any(Number),
      },
    ]);
    expect((await attemptsFor(member.id))[0]).toMatchObject({ status: 'delivered' });
  });
});
