/** The shared API client against the real app: notification settings, phones, channels and mail. */

import { describe, expect, it } from 'vitest';
import type { TokenPair } from '@greenhouse/contract';
import { createApiClient } from '@greenhouse/contract/client';
import { EXPO_TOKEN, fakeNetwork, PROJECT_ID } from '../modules/channels/__tests__/fakes.js';
import { createTestApp, TEST_PASSWORD } from '../testing.js';

describe('the API client', () => {
  it('reaches notification settings, push devices, 管理 → 渠道 and 管理 → 服务 → 邮箱', async () => {
    const net = fakeNetwork();
    const { app, member } = createTestApp({}, { fetch: net.fetch });
    await member('admin', 'admin@example.com');
    await member('member', 'lin@example.com');
    const clientFor = async (email: string) => {
      let stored: TokenPair | null = null;
      const client = createApiClient({
        baseUrl: '',
        tokens: { get: () => stored, set: (tokens) => (stored = tokens) },
        fetch: (input, init) => Promise.resolve(app.request(String(input), init)),
      });
      await client.auth.login(email, TEST_PASSWORD);
      return client;
    };
    const asAdmin = await clientFor('admin@example.com');
    const asLin = await clientFor('lin@example.com');

    expect((await asAdmin.admin.channels.list()).items.map((item) => item.channel)).toEqual([
      'feishu',
      'wecom',
      'push',
    ]);
    expect(await asAdmin.admin.mail.get()).toMatchObject({ can_send: false, mailboxes: false, receivers: [] });
    expect(
      await asLin.me.pushDevices.register({ token: EXPO_TOKEN(), platform: 'ios', project_id: PROJECT_ID }),
    ).toEqual({ device: null, enabled: false });

    const push = await asAdmin.admin.channels.save('push', {});
    expect(push).toMatchObject({ channel: 'push', configured: true });
    // Email goes out through the mail service: any instance of it.
    await asAdmin.admin.createProvider({
      capability: 'mail',
      kind: 'smtp',
      name: 'SMTP',
      config: { host: 'smtp.example.com', security: 'tls', fromAddress: 'gh@example.com' },
      secrets: {},
    });
    expect(await asAdmin.admin.mail.get()).toMatchObject({ can_send: true, mailboxes: false });
    expect(await asAdmin.admin.mail.save({ agent_domain: 'agents.example.com' })).toMatchObject({
      agent_domain: 'agents.example.com',
      agent_domain_source: 'workspace',
      // SMTP only sends: no Agent mailboxes until an instance that receives comes first.
      mailboxes: false,
    });
    await expect(asLin.admin.channels.list()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    await expect(asLin.admin.mail.get()).rejects.toMatchObject({ status: 403, code: 'forbidden' });

    const registered = await asLin.me.pushDevices.register({
      token: EXPO_TOKEN(),
      platform: 'android',
      project_id: PROJECT_ID,
      client_ref: 'station-a',
    });
    expect(registered.enabled).toBe(true);
    const id = registered.device!.id;
    expect((await asLin.me.pushDevices.list()).devices.map((device) => device.id)).toEqual([id]);
    expect((await asLin.me.pushDevices.update(id, { replies: false })).device.prefs.replies).toBe(false);
    expect(await asLin.me.pushDevices.test(id)).toEqual({ ok: true });
    await expect(asLin.me.pushDevices.test(id)).rejects.toMatchObject({ status: 429, code: 'too_soon' });

    const settings = await asLin.me.notificationSettings.get();
    expect(settings.channels).toEqual(['email', 'push']);
    const saved = await asLin.me.notificationSettings.save({ categories: { other: { push: true } }, previews: true });
    expect(saved).toMatchObject({ previews: true, categories: { other: { email: false, push: true } } });

    expect(await asLin.me.pushDevices.unregister(id)).toEqual({ ok: true });
    expect((await asLin.me.notificationSettings.get()).channels).toEqual(['email']);
  });
});
