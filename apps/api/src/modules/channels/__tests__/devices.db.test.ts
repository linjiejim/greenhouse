import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, members, pushDevices } from '@greenhouse/db';
import { createTestApp, TEST_PASSWORD } from '../../../testing.js';
import { MAX_ACTIVE_PUSH_DEVICES } from '../devices.js';
import { EXPO_TOKEN, fakeNetwork, PROJECT_ID } from './fakes.js';

async function setup(env: Record<string, string> = { PUSH_PROVIDER: 'expo' }) {
  const net = fakeNetwork();
  const app = createTestApp(env, { fetch: net.fetch });
  const lin = await app.member();
  const register = (token = EXPO_TOKEN(), extra: Record<string, unknown> = {}, as = lin.token) =>
    app.call('PUT', '/api/me/push-devices', {
      token: as,
      body: { token, platform: 'ios', project_id: PROJECT_ID, ...extra },
    });
  return { ...app, net, lin, register };
}

describe('push devices', () => {
  it('stores nothing when this deployment sends no pushes', async () => {
    const { call, lin, register } = await setup({});
    expect((await register()).body).toEqual({ device: null, enabled: false });
    expect((await call('GET', '/api/me/push-devices', { token: lin.token })).body).toEqual({
      devices: [],
      enabled: false,
    });
    expect(await getDb().select().from(pushDevices)).toHaveLength(0);
  });

  it('registers by token in the shape the apps send, refreshes it, and keeps the token to itself', async () => {
    const { call, lin, register } = await setup();
    const first = await register(EXPO_TOKEN(), { client_ref: 'station-a', prefs: { replies: false } });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      enabled: true,
      device: {
        id: expect.stringMatching(/^pdv_/),
        platform: 'ios',
        client_ref: 'station-a',
        prefs: { needs_you: true, done: true, replies: false, preview: true, live_activity: false },
        created_at: expect.any(String),
        last_seen_at: expect.any(String),
      },
    });
    expect(JSON.stringify(first.body)).not.toContain('device-1');
    // The same phone again keeps its row and its switches.
    const again = await register(EXPO_TOKEN(), { client_ref: 'station-a' });
    expect(again.body.device.id).toBe(first.body.device.id);
    expect(again.body.device.prefs.replies).toBe(false);
    const list = await call('GET', '/api/me/push-devices', { token: lin.token });
    expect(list.body).toEqual({ devices: [again.body.device], enabled: true });

    const patched = await call('PATCH', `/api/me/push-devices/${first.body.device.id}`, {
      token: lin.token,
      body: { prefs: { preview: false, live_activity: true } },
    });
    expect(patched.body.device.prefs).toMatchObject({ replies: false, preview: false, live_activity: true });
    expect(
      (await call('PATCH', `/api/me/push-devices/${first.body.device.id}`, { token: lin.token, body: { prefs: {} } }))
        .status,
    ).toBe(400);

    for (const body of [
      { token: 'not-a-token', platform: 'ios', project_id: PROJECT_ID },
      { token: EXPO_TOKEN(), platform: 'windows', project_id: PROJECT_ID },
      { token: EXPO_TOKEN(), platform: 'ios', project_id: 'nope' },
      { token: EXPO_TOKEN(), platform: 'ios', project_id: PROJECT_ID, client_ref: 'has space' },
    ]) {
      expect((await call('PUT', '/api/me/push-devices', { token: lin.token, body })).body.error.code).toBe(
        'invalid_input',
      );
    }
  });

  it('moves a phone to whoever signs in on it, with fresh switches; only its owner can touch it', async () => {
    const { call, member, lin, register } = await setup();
    const mine = await register(EXPO_TOKEN(), { prefs: { needs_you: false } });
    const chen = await member();
    expect(
      (
        await call('PATCH', `/api/me/push-devices/${mine.body.device.id}`, {
          token: chen.token,
          body: { prefs: { done: false } },
        })
      ).status,
    ).toBe(404);
    expect((await call('DELETE', `/api/me/push-devices/${mine.body.device.id}`, { token: chen.token })).status).toBe(
      404,
    );

    const moved = await register(EXPO_TOKEN(), {}, chen.token);
    expect(moved.body.device.id).toBe(mine.body.device.id);
    expect(moved.body.device.prefs.needs_you).toBe(true);
    expect((await call('GET', '/api/me/push-devices', { token: lin.token })).body.devices).toEqual([]);
    expect((await call('GET', '/api/me/push-devices', { token: chen.token })).body.devices).toHaveLength(1);
  });

  it('disables instead of deleting, and a new registration brings the phone back', async () => {
    const { call, lin, register } = await setup();
    const phone = await register();
    const id = phone.body.device.id;
    expect((await call('DELETE', `/api/me/push-devices/${id}`, { token: lin.token })).body).toEqual({ ok: true });
    expect((await call('GET', '/api/me/push-devices', { token: lin.token })).body.devices).toEqual([]);
    const [row] = await getDb().select().from(pushDevices).where(eq(pushDevices.id, id));
    expect(row).toMatchObject({ disabledReason: 'unregistered' });
    expect(row!.disabledAt).not.toBeNull();
    expect(
      (await call('PATCH', `/api/me/push-devices/${id}`, { token: lin.token, body: { prefs: { done: false } } }))
        .status,
    ).toBe(404);

    const back = await register();
    expect(back.body.device.id).toBe(id);
    expect((await call('GET', '/api/me/push-devices', { token: lin.token })).body.devices).toHaveLength(1);
  });

  it(`keeps at most ${MAX_ACTIVE_PUSH_DEVICES} phones per member, retiring the one seen least recently`, async () => {
    const { call, lin, register } = await setup();
    const ids: string[] = [];
    for (let n = 1; n <= MAX_ACTIVE_PUSH_DEVICES + 1; n++) {
      ids.push((await register(EXPO_TOKEN(n))).body.device.id);
      // Seen one after another.
      await getDb()
        .update(pushDevices)
        .set({ lastSeenAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString() })
        .where(eq(pushDevices.id, ids.at(-1)!));
    }
    const active = (await call('GET', '/api/me/push-devices', { token: lin.token })).body.devices;
    expect(active).toHaveLength(MAX_ACTIVE_PUSH_DEVICES);
    const [retired] = await getDb().select().from(pushDevices).where(eq(pushDevices.id, ids[0]!));
    expect(retired!.disabledReason).toBe('device_limit');
  });

  it('sends a test push now, at most one per phone every ten seconds', async () => {
    const { call, net, lin, register } = await setup();
    const id = (await register(EXPO_TOKEN(), { client_ref: 'station-a' })).body.device.id;
    expect((await call('POST', `/api/me/push-devices/${id}/test`, { token: lin.token })).body).toEqual({ ok: true });
    expect(net.state.pushes[0]).toMatchObject({
      to: EXPO_TOKEN(),
      title: 'Greenhouse',
      data: { v: 1, s: 'station-a', u: lin.id, k: 'test', nid: 'test' },
    });
    const soon = await call('POST', `/api/me/push-devices/${id}/test`, { token: lin.token });
    expect(soon).toMatchObject({ status: 429, body: { error: { code: 'too_soon' } } });
  });

  it('disables a phone Expo says no longer has the app', async () => {
    const { call, net, lin, register } = await setup();
    const id = (await register()).body.device.id;
    net.state.ticket = () => ({ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } });
    const test = await call('POST', `/api/me/push-devices/${id}/test`, { token: lin.token });
    expect(test).toMatchObject({ status: 409, body: { error: { code: 'device_not_registered' } } });
    const [row] = await getDb().select().from(pushDevices).where(eq(pushDevices.id, id));
    expect(row!.disabledReason).toBe('device_not_registered');
    expect((await call('POST', `/api/me/push-devices/${id}/test`, { token: lin.token })).body.error.code).toBe(
      'device_disabled',
    );
  });

  it('stops pushing to phones registered before a password change', async () => {
    const { call, services, lin, register } = await setup();
    await register();
    const before = await services.channels.settings(lin.id);
    expect(before.channels).toEqual(['push']);
    const changed = await call('POST', '/api/me/password', {
      token: lin.token,
      body: { current_password: TEST_PASSWORD, new_password: 'another horse battery' },
    });
    expect(changed.status).toBe(204);
    const [row] = await getDb().select().from(members).where(eq(members.id, lin.id));
    expect(row!.authVersion).toBe(1);
    expect((await services.channels.settings(lin.id)).channels).toEqual([]);
  });
});
