import { afterEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { connections, getDb, jobs, members, newId, pushDevices, requests, type JobRow } from '@greenhouse/db';
import { claimJobs, settleJob } from '../../../jobs.js';
import { createTestApp, createTestServices } from '../../../testing.js';
import type { PublishInput } from '../../notifications/service.js';
import { EXPO_TOKEN, fakeNetwork, PROJECT_ID, readMail, smtpInstance, startFakeSmtp, type FakeSmtp } from './fakes.js';

let smtp: FakeSmtp | null = null;
afterEach(async () => {
  await smtp?.close();
  smtp = null;
});

async function setup(env: Record<string, string> = {}) {
  smtp = await startFakeSmtp();
  const net = fakeNetwork();
  const app = createTestApp(env, { fetch: net.fetch });
  const admin = await app.member('admin');
  const lin = await app.member('member', 'lin@acme.com');
  const mailId = await smtpInstance(app.call, admin.token, {
    host: '127.0.0.1',
    port: smtp.port,
    security: 'none',
    fromAddress: 'gh@acme.com',
  });
  const settings = (body: unknown, token = lin.token) =>
    app.call('PUT', '/api/me/notification-settings', { token, body });
  await settings({ categories: { needs_you: { email: true }, runs: { email: true } } });
  const publish = (input: Partial<PublishInput> = {}) =>
    app.services.notifications.publish({
      memberId: lin.id,
      kind: 'run_done',
      title: '后台运行完成：周报',
      body: '本周完成 12 项',
      targetType: 'conversation',
      targetId: 'cnv_weekly',
      runId: newId('run'),
      dedupeKey: newId('job'),
      ...input,
    });
  const deliveries = (channel?: string) =>
    getDb()
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.kind, 'deliver_notification'), channel ? sql`${jobs.payload}->>'channel' = ${channel}` : undefined),
      )
      .orderBy(asc(jobs.id));
  /** Makes waiting jobs due now (time stands still inside a test transaction). */
  const due = () =>
    getDb()
      .update(jobs)
      .set({ availableAt: sql`now() - interval '1 second'` })
      .where(eq(jobs.status, 'pending'));
  const run = () => app.services.channels.runOnce();
  return { ...app, net, admin, lin, mailId, settings, publish, deliveries, due, run };
}

describe('the delivery worker', () => {
  it('emails a member who opted in, once, with the link back and no content', async () => {
    const { publish, deliveries, run } = await setup();
    const published = await publish();
    // Idempotent per notification: the same dedupe key publishes nothing more.
    expect(await publish({ dedupeKey: 'run:x:1' })).not.toBeNull();
    expect(await publish({ dedupeKey: 'run:x:1' })).toBeNull();
    const queued = await deliveries();
    expect(queued.map((job) => [job.status, job.dedupeKey])).toEqual([
      ['pending', `deliver:${published!.id}:email`],
      ['suppressed', expect.stringMatching(/^deliver:ntf_.*:email$/)],
    ]);

    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
    expect(smtp!.mails).toHaveLength(1);
    const mail = await readMail(smtp!.mails[0]!);
    expect(mail.to).toEqual(['lin@acme.com']);
    expect(mail.subject).toBe('Greenhouse：后台运行完成了（共 2 条）');
    expect(mail.text).toContain('http://greenhouse.test/#/c/cnv_weekly');
    expect(mail.text).not.toContain('本周完成');
    const [sent] = await deliveries();
    expect(sent).toMatchObject({ status: 'succeeded', attempts: 1, leaseOwner: null, lastError: null });
    expect(sent!.result).toMatchObject({ instance: expect.any(String) });
  });

  it('retries with backoff, then delivers; a refused recipient is given up at once', async () => {
    const { publish, deliveries, run, due, lin } = await setup();
    smtp!.answers.push('451 4.3.0 try again later');
    await publish();
    await run();
    const [failed] = await deliveries();
    expect(failed).toMatchObject({ status: 'pending', attempts: 1, lastError: expect.stringContaining('451') });
    // Not due before its backoff.
    expect(await run()).toBe(0);

    await due();
    await run();
    expect(smtp!.mails).toHaveLength(1);
    expect((await deliveries())[0]).toMatchObject({ status: 'succeeded', attempts: 2, lastError: null });

    smtp!.refuse.set('lin@acme.com', '550 5.1.1 mailbox unavailable');
    await getDb().update(members).set({ email: 'lin@acme.com' }).where(eq(members.id, lin.id));
    await publish({ targetId: 'cnv_other' });
    await run();
    expect((await deliveries()).at(-1)).toMatchObject({ status: 'dead', attempts: 1 });
  });

  it('gives up after its last attempt', async () => {
    const { publish, deliveries, run } = await setup();
    smtp!.answers.push('421 4.7.0 too busy');
    await publish();
    const [job] = await deliveries();
    await getDb()
      .update(jobs)
      .set({ attempts: job!.maxAttempts - 1 })
      .where(eq(jobs.id, job!.id));
    await run();
    expect((await deliveries())[0]).toMatchObject({ status: 'dead', attempts: job!.maxAttempts });
  });

  it('picks up a delivery whose process died, and that process can no longer settle it', async () => {
    const { publish, deliveries, net } = await setup();
    await publish();
    const [claimed] = await claimJobs(['deliver_notification'], 'process-that-died', { limit: 5, leaseMs: 60_000 });
    expect(claimed).toMatchObject({ status: 'claimed', leaseOwner: 'process-that-died', attempts: 1 });
    // A restart: another process, and the dead one's lease runs out.
    const restarted = createTestServices({}, { fetch: net.fetch });
    expect(await restarted.channels.runOnce()).toBe(0);
    await getDb()
      .update(jobs)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(jobs.id, claimed!.id));
    expect(await restarted.channels.runOnce()).toBe(1);
    expect(smtp!.mails).toHaveLength(1);
    expect((await deliveries())[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(await settleJob(claimed as JobRow, 'process-that-died', { status: 'succeeded' })).toBeNull();
  });

  it('suppresses what no longer makes sense by the time it goes out', async () => {
    const { publish, deliveries, run, call, lin, settings, admin, services, mailId } = await setup();
    const read = await publish({ targetId: 'cnv_1' });
    await call('POST', '/api/notifications/read', { token: lin.token, body: { ids: [read!.id] } });
    await run();
    await publish({ targetId: 'cnv_2' });
    await settings({ categories: { runs: { email: false } } });
    await run();
    expect((await deliveries()).map((job) => job.result?.reason)).toEqual(['read', 'channel_off']);

    await settings({ categories: { runs: { email: true } } });
    const card = await services.requests.create({
      memberId: lin.id,
      kind: 'approval',
      subject: 'tool_write',
      title: 'Greeny 请你批准：写一条笔记',
      payload: {},
      conversationId: 'cnv_3',
    });
    // The card ran out before the email went (deciding it would also mark it read).
    await getDb()
      .update(requests)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(requests.id, card.id));
    await publish({ targetId: 'cnv_4' });
    await call('PATCH', `/api/admin/providers/${mailId}`, { token: admin.token, body: { enabled: false } });
    await run();
    expect((await deliveries()).slice(2).map((job) => job.result?.reason)).toEqual([
      'request_settled',
      'not_configured',
    ]);

    await call('PATCH', `/api/admin/providers/${mailId}`, { token: admin.token, body: { enabled: true } });
    await publish({ targetId: 'cnv_5' });
    await getDb().update(members).set({ status: 'disabled' }).where(eq(members.id, lin.id));
    await run();
    expect((await deliveries()).at(-1)!.result?.reason).toBe('member_inactive');
    expect(smtp!.mails).toHaveLength(0);
  });

  it('makes one message of a burst from one source, and starts again after the window', async () => {
    const { publish, deliveries, run } = await setup();
    await publish();
    await publish();
    await run();
    expect(smtp!.mails).toHaveLength(1);
    // Within the window, after one went out: recorded, not sent.
    await publish();
    // Another source is news.
    await publish({ targetId: 'cnv_other' });
    await run();
    expect(smtp!.mails).toHaveLength(2);
    expect((await deliveries()).map((job) => [job.status, job.result?.reason ?? null])).toEqual([
      ['succeeded', null],
      ['suppressed', 'folded'],
      ['suppressed', 'collapsed'],
      ['succeeded', null],
    ]);
    // A different category from the same source is not folded into it.
    await publish({ kind: 'request', title: 'Greeny 请你批准', runId: undefined });
    await run();
    expect(smtp!.mails).toHaveLength(3);
    expect((await deliveries()).at(-1)).toMatchObject({ status: 'succeeded' });
  });

  it('messages linked Feishu and WeCom accounts in plain text, naming the subject only with previews', async () => {
    const { publish, run, call, admin, lin, member, net, settings, deliveries } = await setup();
    await call('PUT', '/api/admin/channels/feishu', {
      token: admin.token,
      body: { app_id: `cli_${newId('job')}`, app_secret: 'feishu-secret' },
    });
    await call('PUT', '/api/admin/channels/wecom', {
      token: admin.token,
      body: { corp_id: `ww_${newId('job')}`, agent_id: 1000002, secret: 'wecom-secret' },
    });
    await getDb()
      .insert(connections)
      .values([
        { id: newId('connection'), memberId: lin.id, kind: 'feishu', externalId: 'ou_lin' },
        { id: newId('connection'), memberId: lin.id, kind: 'wecom', externalId: 'LinJie' },
      ]);
    const chen = await member();
    await publish();
    await publish({ memberId: chen.id });
    await run();
    expect(net.state.feishu).toEqual([
      {
        to: 'ou_lin',
        text: 'Greenhouse：后台运行完成了\nhttp://greenhouse.test/#/c/cnv_weekly',
        token: expect.any(String),
      },
    ]);
    expect(net.state.wecom).toEqual([
      {
        to: 'LinJie',
        text: 'Greenhouse：后台运行完成了\nhttp://greenhouse.test/#/c/cnv_weekly',
        token: expect.any(String),
      },
    ]);
    // Chen linked nothing and never asked for email: nothing was queued for them.
    expect((await deliveries()).every((job) => job.status === 'succeeded')).toBe(true);

    await settings({ previews: true });
    await publish({ targetId: 'cnv_preview' });
    await run();
    expect(net.state.feishu.at(-1)!.text).toBe(
      '后台运行完成：周报\n本周完成 12 项\nhttp://greenhouse.test/#/c/cnv_preview',
    );

    net.state.feishuAnswer = () => ({
      status: 400,
      body: { code: 230013, msg: 'Bot has NO availability to this user.' },
    });
    await publish({ targetId: 'cnv_refused' });
    await run();
    expect((await deliveries('feishu')).at(-1)).toMatchObject({
      status: 'dead',
      lastError: expect.stringContaining('230013'),
    });
  });

  it('pushes to each phone as its switches allow, never twice, and checks the receipts later', async () => {
    const { publish, run, due, call, lin, net, deliveries } = await setup({ PUSH_PROVIDER: 'expo' });
    const register = async (n: number, prefs: Record<string, boolean> = {}) =>
      (
        await call('PUT', '/api/me/push-devices', {
          token: lin.token,
          body: { token: EXPO_TOKEN(n), platform: 'ios', project_id: PROJECT_ID, client_ref: `station-${n}`, prefs },
        })
      ).body.device.id as string;
    const banner = await register(1);
    await register(2, { done: false, live_activity: true });
    await register(3, { done: false });

    // The first phone is rate limited once; the second takes it at once.
    let first = true;
    net.state.ticket = (message) =>
      message.to === EXPO_TOKEN(1) && first
        ? ((first = false), { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } })
        : { status: 'ok', id: `ticket-${String(message.to)}` };
    const published = await publish({ agentId: undefined });
    await run();
    expect(net.state.pushes).toHaveLength(2);
    const [toBanner, silent] = net.state.pushes;
    expect(toBanner).toMatchObject({
      to: EXPO_TOKEN(1),
      title: 'Greenhouse',
      body: '后台运行完成了',
      sound: 'default',
      badge: 0,
      priority: 'high',
      interruptionLevel: 'active',
      data: {
        v: 1,
        s: 'station-1',
        u: lin.id,
        k: 'done',
        nid: published!.id,
        sid: 'cnv_weekly',
        url: '/c/cnv_weekly',
        run: published!.run_id,
        st: 'succeeded',
      },
    });
    expect(silent).toMatchObject({ to: EXPO_TOKEN(2), _contentAvailable: true, priority: 'normal' });
    expect(silent).not.toHaveProperty('title');
    const [pushJob] = await deliveries('push');
    expect(pushJob).toMatchObject({ status: 'pending', result: { sent: [expect.any(String)] } });

    await due();
    await run();
    // Only the phone that missed it gets it now.
    expect(net.state.pushes.map((push) => push.to)).toEqual([EXPO_TOKEN(1), EXPO_TOKEN(2), EXPO_TOKEN(1)]);
    expect((await deliveries('push'))[0]).toMatchObject({ status: 'succeeded' });

    // Fifteen minutes later Expo says the first phone no longer has the app.
    net.state.receipt = (id) =>
      id === `ticket-${EXPO_TOKEN(1)}`
        ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
        : { status: 'ok' };
    const receiptJobs = await getDb().select().from(jobs).where(eq(jobs.kind, 'push_receipts'));
    expect(receiptJobs).toHaveLength(2);
    await due();
    await run();
    expect(net.state.receiptAsks.flat().sort()).toEqual([`ticket-${EXPO_TOKEN(1)}`, `ticket-${EXPO_TOKEN(2)}`]);
    const [phone] = await getDb().select().from(pushDevices).where(eq(pushDevices.id, banner));
    expect(phone!.disabledReason).toBe('device_not_registered');
  });

  it('disables a phone whose push Expo refuses as not registered, and drops a request Expo refuses', async () => {
    const { publish, run, call, lin, net, deliveries } = await setup({ PUSH_PROVIDER: 'expo' });
    const id = (
      await call('PUT', '/api/me/push-devices', {
        token: lin.token,
        body: { token: EXPO_TOKEN(), platform: 'android', project_id: PROJECT_ID },
      })
    ).body.device.id;
    net.state.ticket = () => ({ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } });
    await publish();
    await run();
    const [row] = await getDb().select().from(pushDevices).where(eq(pushDevices.id, id));
    expect(row!.disabledReason).toBe('device_not_registered');
    expect((await deliveries('push'))[0]).toMatchObject({ status: 'succeeded' });

    await call('PUT', '/api/me/push-devices', {
      token: lin.token,
      body: { token: EXPO_TOKEN(), platform: 'android', project_id: PROJECT_ID },
    });
    net.state.sendFailure = { status: 400, body: { errors: [{ code: 'VALIDATION_ERROR', message: 'bad' }] } };
    await publish({ targetId: 'cnv_other' });
    await run();
    expect((await deliveries('push')).at(-1)).toMatchObject({
      status: 'dead',
      lastError: expect.stringContaining('VALIDATION_ERROR'),
    });
  });
});
