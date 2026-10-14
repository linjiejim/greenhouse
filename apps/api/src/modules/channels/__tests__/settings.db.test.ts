import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connections, getDb, members, newId } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';
import { EXPO_TOKEN, fakeNetwork, PROJECT_ID, smtpInstance } from './fakes.js';

describe('设置 → 通知', () => {
  it('offers only the channels set up and connected for me', async () => {
    const net = fakeNetwork();
    const { call, member } = createTestApp({}, { fetch: net.fetch });
    const admin = await member('admin');
    const lin = await member();
    const get = async () => (await call('GET', '/api/me/notification-settings', { token: lin.token })).body;

    expect(await get()).toEqual({
      channels: [],
      categories: { needs_you: {}, replies: {}, runs: {}, other: {} },
      previews: false,
    });

    await smtpInstance(call, admin.token, { host: 'smtp.acme.com', security: 'starttls', fromAddress: 'gh@acme.com' });
    await call('PUT', '/api/admin/channels/feishu', {
      token: admin.token,
      body: { app_id: 'cli_settings', app_secret: 'secret' },
    });
    await call('PUT', '/api/admin/channels/push', { token: admin.token, body: {} });
    // Feishu is set up but not linked by Lin; push is set up but Lin has no phone yet.
    expect((await get()).channels).toEqual(['email']);
    expect((await get()).categories.needs_you).toEqual({ email: false });

    await getDb()
      .insert(connections)
      .values({ id: newId('connection'), memberId: lin.id, kind: 'feishu', externalId: 'ou_lin' });
    const phone = await call('PUT', '/api/me/push-devices', {
      token: lin.token,
      body: { token: EXPO_TOKEN(), platform: 'ios', project_id: PROJECT_ID },
    });
    expect(phone.body.enabled).toBe(true);
    const all = await get();
    expect(all.channels).toEqual(['email', 'feishu', 'push']);
    expect(all.categories).toEqual({
      needs_you: { email: false, feishu: true, push: true },
      replies: { email: false, feishu: false, push: true },
      runs: { email: false, feishu: true, push: true },
      other: { email: false, feishu: false, push: false },
    });

    // An unregistered phone, or a Feishu account that needs signing in again, is not a channel.
    await call('DELETE', `/api/me/push-devices/${phone.body.device.id}`, { token: lin.token });
    await getDb().update(connections).set({ status: 'needs_reauth' }).where(eq(connections.memberId, lin.id));
    expect((await get()).channels).toEqual(['email']);
  });

  it('saves my switches and previews; what I leave out keeps its value', async () => {
    const { call, member } = createTestApp();
    const admin = await member('admin');
    const lin = await member();
    await smtpInstance(call, admin.token, { host: 'smtp.acme.com', fromAddress: 'gh@acme.com' });
    const saved = await call('PUT', '/api/me/notification-settings', {
      token: lin.token,
      body: { categories: { needs_you: { email: true }, runs: { email: true } } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      channels: ['email'],
      categories: { needs_you: { email: true }, runs: { email: true }, replies: { email: false } },
      previews: false,
    });
    const next = await call('PUT', '/api/me/notification-settings', {
      token: lin.token,
      body: { categories: { runs: { email: false } }, previews: true },
    });
    expect(next.body).toMatchObject({
      categories: { needs_you: { email: true }, runs: { email: false } },
      previews: true,
    });
    const [row] = await getDb().select().from(members).where(eq(members.id, lin.id));
    expect(row!.notificationSettings).toEqual({
      categories: { needs_you: { email: true }, runs: { email: false } },
      previews: true,
    });

    for (const body of [{ categories: { needs_you: { sms: true } } }, { categories: { chats: {} } }, { muted: [] }]) {
      expect((await call('PUT', '/api/me/notification-settings', { token: lin.token, body })).status).toBe(400);
    }
    // Settings are mine: /api/me no longer carries them.
    expect((await call('GET', '/api/me', { token: lin.token })).body).not.toHaveProperty('notification_settings');
  });
});
