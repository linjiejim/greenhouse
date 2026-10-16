import { describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { auditEvents, connections, getDb, newId, providers } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';
import { EXPO_TOKEN, fakeNetwork, PROJECT_ID } from './fakes.js';

describe('管理 → 渠道', () => {
  it('lists Feishu, WeCom and push (email is the mail service), and only for admins', async () => {
    const { call, member } = createTestApp();
    const admin = await member('admin');
    const lin = await member();
    expect((await call('GET', '/api/admin/channels', { token: lin.token })).status).toBe(403);
    const list = await call('GET', '/api/admin/channels', { token: admin.token });
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual(
      ['feishu', 'wecom', 'push'].map((channel) => ({
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

  it('saves a channel with a write-only secret, audited, and drops the secret when the address moves', async () => {
    const { call, member } = createTestApp();
    const admin = await member('admin');
    const appId = `cli_${newId('connector')}`;
    expect((await call('PUT', '/api/admin/channels/email', { token: admin.token, body: {} })).status).toBe(400);
    const saved = await call('PUT', '/api/admin/channels/feishu', {
      token: admin.token,
      body: { app_id: appId, app_secret: 'feishu-secret' },
    });
    expect(saved.body).toMatchObject({ channel: 'feishu', source: 'workspace', secrets_set: ['app_secret'] });
    expect(JSON.stringify(saved.body)).not.toContain('feishu-secret');
    const [row] = await getDb().select().from(providers).where(eq(providers.capability, 'im'));
    expect(row!.secretsEnc).not.toContain('feishu-secret');
    const audits = await getDb()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorId, admin.id), like(auditEvents.action, 'provider.%')));
    expect(audits.map((entry) => entry.action)).toContain('provider.create');
    expect(audits.every((entry) => !entry.summary.includes('feishu-secret'))).toBe(true);
    // Another address: the secret does not follow it.
    const moved = await call('PUT', '/api/admin/channels/feishu', {
      token: admin.token,
      body: { base_url: 'https://open.larksuite.com' },
    });
    expect(moved.body).toMatchObject({ secrets_set: [], settings: { base_url: 'https://open.larksuite.com' } });
    const off = await call('PUT', '/api/admin/channels/feishu', { token: admin.token, body: { enabled: false } });
    expect(off.body).toMatchObject({ configured: false, enabled: false });
    expect(
      (await call('PUT', '/api/admin/channels/feishu', { token: admin.token, body: { nonsense: 1 } })).status,
    ).toBe(400);
  });

  it('shows settings from env as such, and a save takes their place', async () => {
    const net = fakeNetwork();
    const { call, member } = createTestApp(
      { PUSH_PROVIDER: 'expo', EXPO_ACCESS_TOKEN: 'env-token' },
      { fetch: net.fetch },
    );
    const admin = await member('admin');
    const list = await call('GET', '/api/admin/channels', { token: admin.token });
    expect(list.body.items.find((item: { channel: string }) => item.channel === 'push')).toMatchObject({
      configured: true,
      source: 'env',
      secrets_set: ['access_token'],
      settings: { base_url: 'https://exp.host' },
    });
    const saved = await call('PUT', '/api/admin/channels/push', { token: admin.token, body: { enabled: true } });
    expect(saved.body).toMatchObject({ source: 'workspace', configured: true, secrets_set: ['access_token'] });
    // Turned off, the copy stays first: the env settings do not take over again.
    const off = await call('PUT', '/api/admin/channels/push', { token: admin.token, body: { enabled: false } });
    expect(off.body).toMatchObject({ source: 'workspace', configured: false, enabled: false });
  });
});
