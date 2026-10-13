import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { auditEvents, connections, getDb, newId, providers } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';
import { EXPO_TOKEN, fakeNetwork, PROJECT_ID, readMail, startFakeSmtp, type FakeSmtp } from './fakes.js';

let smtp: FakeSmtp | null = null;
afterEach(async () => {
  await smtp?.close();
  smtp = null;
});

const emailSettings = (port: number) => ({
  host: '127.0.0.1',
  port,
  security: 'none',
  username: 'bot@acme.com',
  from_address: 'bot@acme.com',
  from_name: 'Acme',
  password: 'smtp-secret',
});

describe('管理 → 渠道', () => {
  it('lists the four channels, and only for admins', async () => {
    const { call, member } = createTestApp();
    const admin = await member('admin');
    const lin = await member();
    expect((await call('GET', '/api/admin/channels', { token: lin.token })).status).toBe(403);
    const list = await call('GET', '/api/admin/channels', { token: admin.token });
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual(
      ['email', 'feishu', 'wecom', 'push'].map((channel) => ({
        channel,
        configured: false,
        source: null,
        enabled: false,
        secrets_set: [],
        last_success_at: null,
        last_error: null,
        last_error_at: null,
        settings: null,
      })),
    );
  });

  it('saves email settings with a write-only password, audited, and drops the password when the server moves', async () => {
    smtp = await startFakeSmtp();
    const { call, member } = createTestApp();
    const admin = await member('admin');

    const incomplete = await call('PUT', '/api/admin/channels/email', { token: admin.token, body: { password: 'x' } });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.error.details.map((issue: { path: string }) => issue.path).sort()).toEqual([
      'from_address',
      'host',
    ]);

    const saved = await call('PUT', '/api/admin/channels/email', {
      token: admin.token,
      body: emailSettings(smtp.port),
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      channel: 'email',
      configured: true,
      source: 'workspace',
      enabled: true,
      secrets_set: ['password'],
      settings: {
        host: '127.0.0.1',
        port: smtp.port,
        security: 'none',
        username: 'bot@acme.com',
        from_address: 'bot@acme.com',
        from_name: 'Acme',
      },
    });
    expect(JSON.stringify(saved.body)).not.toContain('smtp-secret');
    const [row] = await getDb().select().from(providers).where(eq(providers.capability, 'mail'));
    expect(row!.secretsEnc).not.toContain('smtp-secret');
    const audits = await getDb()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorId, admin.id), like(auditEvents.action, 'provider.%')));
    expect(audits.map((entry) => entry.action)).toContain('provider.create');
    expect(audits.every((entry) => !entry.summary.includes('smtp-secret'))).toBe(true);

    // Same server, a new display name: the password stays.
    const renamed = await call('PUT', '/api/admin/channels/email', { token: admin.token, body: { from_name: null } });
    expect(renamed.body).toMatchObject({ secrets_set: ['password'], settings: { from_name: null } });
    // Another server: the password does not follow it.
    const moved = await call('PUT', '/api/admin/channels/email', { token: admin.token, body: { host: 'localhost' } });
    expect(moved.body).toMatchObject({ secrets_set: [], settings: { host: 'localhost' } });

    const off = await call('PUT', '/api/admin/channels/email', { token: admin.token, body: { enabled: false } });
    expect(off.body).toMatchObject({ configured: false, enabled: false });
    expect((await call('PUT', '/api/admin/channels/email', { token: admin.token, body: { nonsense: 1 } })).status).toBe(
      400,
    );
  });

  it('sets up Feishu, WeCom and push, and tests each against the admin themself', async () => {
    const net = fakeNetwork();
    const { call, member } = createTestApp({}, { fetch: net.fetch });
    const admin = await member('admin');
    const appId = `cli_${newId('connector')}`;

    const feishu = await call('PUT', '/api/admin/channels/feishu', {
      token: admin.token,
      body: { app_id: appId, app_secret: 'feishu-secret' },
    });
    expect(feishu.body).toMatchObject({
      configured: true,
      secrets_set: ['app_secret'],
      settings: { base_url: 'https://open.feishu.cn', app_id: appId },
    });
    // Keys work, but the admin has no linked account to send to.
    expect((await call('POST', '/api/admin/channels/feishu/test', { token: admin.token })).body).toMatchObject({
      ok: true,
      delivered: 0,
      error: null,
    });
    await getDb()
      .insert(connections)
      .values({
        id: newId('connection'),
        memberId: admin.id,
        kind: 'feishu',
        externalId: 'ou_admin',
        displayName: 'Admin',
      });
    expect((await call('POST', '/api/admin/channels/feishu/test', { token: admin.token })).body).toMatchObject({
      ok: true,
      delivered: 1,
    });
    expect(net.state.feishu).toEqual([expect.objectContaining({ to: 'ou_admin' })]);

    const wecom = await call('PUT', '/api/admin/channels/wecom', {
      token: admin.token,
      body: { corp_id: `ww_${newId('connector')}`, agent_id: 1000002, secret: 'wecom-secret' },
    });
    expect(wecom.body).toMatchObject({ configured: true, settings: { agent_id: 1000002 } });
    net.state.wecomAnswer = () => ({ status: 200, body: { errcode: 0 } });
    expect((await call('POST', '/api/admin/channels/wecom/test', { token: admin.token })).body.ok).toBe(true);

    expect((await call('POST', '/api/admin/channels/push/test', { token: admin.token })).status).toBe(409);
    const push = await call('PUT', '/api/admin/channels/push', { token: admin.token, body: {} });
    expect(push.body).toMatchObject({ configured: true, secrets_set: [], settings: { base_url: 'https://exp.host' } });
    // No phone yet: the service answers, nothing is sent.
    expect((await call('POST', '/api/admin/channels/push/test', { token: admin.token })).body).toMatchObject({
      ok: true,
      delivered: 0,
    });
    await call('PUT', '/api/me/push-devices', {
      token: admin.token,
      body: { token: EXPO_TOKEN(7), platform: 'ios', project_id: PROJECT_ID },
    });
    expect((await call('POST', '/api/admin/channels/push/test', { token: admin.token })).body).toMatchObject({
      ok: true,
      delivered: 1,
    });
    expect(net.state.pushes.at(-1)).toMatchObject({ to: EXPO_TOKEN(7), data: { k: 'test' } });

    // A failing service is reported, not thrown.
    net.state.sendFailure = { status: 401, body: { errors: [{ code: 'UNAUTHORIZED', message: 'push security' }] } };
    expect((await call('POST', '/api/admin/channels/push/test', { token: admin.token })).body).toMatchObject({
      ok: false,
      error: expect.stringContaining('UNAUTHORIZED'),
    });
  });

  it('sends the admin a test email', async () => {
    smtp = await startFakeSmtp();
    const { call, member } = createTestApp();
    const admin = await member('admin', 'boss@acme.com');
    await call('PUT', '/api/admin/channels/email', { token: admin.token, body: emailSettings(smtp.port) });
    const test = await call('POST', '/api/admin/channels/email/test', { token: admin.token });
    expect(test.body).toMatchObject({ ok: true, delivered: 1, error: null });
    expect(smtp.mails[0]!.to).toEqual(['boss@acme.com']);
    expect((await readMail(smtp.mails[0]!)).text).toContain('Greenhouse');

    await smtp.close();
    const down = await call('POST', '/api/admin/channels/email/test', { token: admin.token });
    expect(down.body).toMatchObject({ ok: false, delivered: 0, error: expect.stringContaining('SMTP') });
    expect(JSON.stringify(down.body)).not.toContain('smtp-secret');
  });

  it('shows settings from env as such, and a save takes their place', async () => {
    smtp = await startFakeSmtp();
    const { call, member } = createTestApp({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_SECURITY: 'none',
      SMTP_USER: 'env@acme.com',
      SMTP_PASSWORD: 'env-secret',
      SMTP_FROM: 'env@acme.com',
      PUSH_PROVIDER: 'expo',
    });
    const admin = await member('admin');
    const list = await call('GET', '/api/admin/channels', { token: admin.token });
    const email = list.body.items.find((item: { channel: string }) => item.channel === 'email');
    expect(email).toMatchObject({
      configured: true,
      source: 'env',
      secrets_set: ['password'],
      settings: { host: '127.0.0.1', port: smtp.port, username: 'env@acme.com', from_address: 'env@acme.com' },
    });
    expect(list.body.items.find((item: { channel: string }) => item.channel === 'push')).toMatchObject({
      configured: true,
      source: 'env',
    });

    const saved = await call('PUT', '/api/admin/channels/email', {
      token: admin.token,
      body: { from_name: 'Acme 温室' },
    });
    expect(saved.body).toMatchObject({
      source: 'workspace',
      configured: true,
      secrets_set: ['password'],
      settings: { from_name: 'Acme 温室', username: 'env@acme.com' },
    });
    const test = await call('POST', '/api/admin/channels/email/test', { token: admin.token });
    expect(test.body.ok).toBe(true);
    expect(smtp.mails[0]).toMatchObject({ auth: 'env@acme.com:env-secret' });
    expect(smtp.mails[0]!.raw).toMatch(/^From: .*<env@acme\.com>/m);

    // Turned off, the copy stays first: the env settings do not take over again.
    const off = await call('PUT', '/api/admin/channels/email', { token: admin.token, body: { enabled: false } });
    expect(off.body).toMatchObject({ source: 'workspace', configured: false, enabled: false });
  });
});
