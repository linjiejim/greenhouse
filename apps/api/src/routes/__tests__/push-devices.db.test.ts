/**
 * /api/auth/me/push-devices against real PostgreSQL (docs/specs/20261010-mobile-push.md
 * §3.3): register / refresh by token, the member's own devices only (another
 * member's are 404), prefs, unregister, the test push (rate-limited, Expo's verdict
 * passed back, a dead token disables the device) and the deployment switch
 * (`enabled: false`, nothing stored). The token never comes back in a response.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { DEFAULT_PUSH_PREFS } from '@greenhouse/types/push';

import type { AppEnv } from '../../app-env.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import pushDeviceRoutes from '../push-devices.js';

const PROJECT = '1f49365d-7d88-472a-b196-01fcd9c428e5';
let db: DatabaseProvider;
let owner: UserRow;
let other: UserRow;
const originalSwitch = process.env.MOBILE_PUSH_ENABLED;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function app() {
  const users = new Map([owner, other].map((user) => [user.id, user]));
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    const user = users.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  hono.route('/api/auth/me/push-devices', pushDeviceRoutes);
  return hono;
}

async function call(as: UserRow, method: string, path: string, body?: unknown) {
  const res = await app().request(`/api/auth/me/push-devices${path}`, {
    method,
    headers: { 'x-test-user': as.id, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

const registration = (token = `ExponentPushToken[${unique('t')}]`) => ({
  token,
  platform: 'ios',
  project_id: PROJECT,
  client_ref: 'st-home',
});

beforeEach(async () => {
  delete process.env.MOBILE_PUSH_ENABLED;
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  owner = await createInternalTestUser(db, { email: `${unique('push-route-owner')}@test.local` });
  other = await createInternalTestUser(db, { email: `${unique('push-route-other')}@test.local` });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalSwitch === undefined) delete process.env.MOBILE_PUSH_ENABLED;
  else process.env.MOBILE_PUSH_ENABLED = originalSwitch;
  await db.close();
  _resetProvider();
});

describe('push device registration', () => {
  it('registers by token, refreshes the same row, and never returns the token', async () => {
    const body = registration();
    const first = await call(owner, 'PUT', '', body);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({
      enabled: true,
      device: {
        id: expect.stringMatching(/^pdv_/),
        platform: 'ios',
        client_ref: 'st-home',
        prefs: DEFAULT_PUSH_PREFS,
        created_at: expect.any(String),
        last_seen_at: expect.any(String),
      },
    });
    expect(JSON.stringify(first.json)).not.toContain(body.token);

    const again = await call(owner, 'PUT', '', { ...body, client_ref: 'st-work', prefs: { preview: true } });
    expect(again.json.device.id).toBe(first.json.device.id);
    expect(again.json.device).toMatchObject({ client_ref: 'st-work', prefs: { ...DEFAULT_PUSH_PREFS, preview: true } });

    const list = await call(owner, 'GET', '');
    expect(list.json).toEqual({ enabled: true, devices: [again.json.device] });
    expect((await call(other, 'GET', '')).json).toEqual({ enabled: true, devices: [] });
  });

  it('refuses what is not an Expo token, an iOS device or an Expo project', async () => {
    const bad = async (patch: Record<string, unknown>) =>
      (await call(owner, 'PUT', '', { ...registration(), ...patch })).status;
    expect(await bad({ token: 'abc' })).toBe(400);
    expect(await bad({ token: 'ExponentPushToken[has spaces]' })).toBe(400);
    expect(await bad({ platform: 'android' })).toBe(400);
    expect(await bad({ project_id: 'not-a-uuid' })).toBe(400);
    expect(await bad({ client_ref: 'bad ref!' })).toBe(400);
    expect(await bad({ prefs: { replies: 'yes' } })).toBe(400);
    expect(await bad({ client_ref: null })).toBe(200);
  });

  it('changes prefs and unregisters only the member’s own device', async () => {
    const { json } = await call(owner, 'PUT', '', registration());
    const id = json.device.id as string;
    expect((await call(other, 'PATCH', `/${id}`, { prefs: { replies: false } })).status).toBe(404);
    expect((await call(owner, 'PATCH', `/${id}`, {})).status).toBe(400);
    const patched = await call(owner, 'PATCH', `/${id}`, { prefs: { replies: false, preview: true } });
    expect(patched.json.device.prefs).toEqual({ ...DEFAULT_PUSH_PREFS, replies: false, preview: true });
    // the phone's Live Activity switch rides the same prefs (its "done" pushes then wake the app)
    const live = await call(owner, 'PATCH', `/${id}`, { prefs: { live_activity: true } });
    expect(live.json.device.prefs).toEqual({
      ...DEFAULT_PUSH_PREFS,
      replies: false,
      preview: true,
      live_activity: true,
    });
    expect((await call(owner, 'PATCH', `/${id}`, { prefs: { live_activity: 'on' } })).status).toBe(400);

    expect((await call(other, 'DELETE', `/${id}`)).status).toBe(404);
    expect((await call(owner, 'DELETE', `/${id}`)).json).toEqual({ ok: true });
    expect((await call(owner, 'DELETE', `/${id}`)).status).toBe(200);
    expect((await call(owner, 'GET', '')).json.devices).toEqual([]);
    // an unregistered device takes no prefs and sends no test
    expect((await call(owner, 'PATCH', `/${id}`, { prefs: { replies: true } })).status).toBe(404);
    expect((await call(owner, 'POST', `/${id}/test`)).json).toMatchObject({ code: 'device_disabled' });
  });

  it('stores nothing and says so when the deployment has pushes off', async () => {
    process.env.MOBILE_PUSH_ENABLED = 'false';
    const body = registration();
    expect((await call(owner, 'PUT', '', body)).json).toEqual({ device: null, enabled: false });
    expect((await call(owner, 'GET', '')).json).toEqual({ devices: [], enabled: false });
    delete process.env.MOBILE_PUSH_ENABLED;
    expect((await call(owner, 'GET', '')).json.devices).toEqual([]);
  });
});

describe('the test push', () => {
  it('sends one message to Expo for this phone, at most once every 10 seconds', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        sent.push(...(JSON.parse(init.body) as unknown[]));
        return new Response(JSON.stringify({ data: [{ status: 'ok', id: 'ticket-1' }] }), { status: 200 });
      }),
    );
    const { json } = await call(owner, 'PUT', '', registration());
    const id = json.device.id as string;
    expect((await call(other, 'POST', `/${id}/test`)).status).toBe(404);
    const ok = await call(owner, 'POST', `/${id}/test`);
    expect(ok).toEqual({ status: 200, json: { ok: true } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ data: { v: 1, k: 'test', s: 'st-home', u: owner.id } });
    const soon = await call(owner, 'POST', `/${id}/test`);
    expect(soon.status).toBe(429);
    expect(soon.json.code).toBe('too_soon');
  });

  it('passes Expo’s verdict back, and a dead token disables the device', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] }),
            { status: 200 },
          ),
      ),
    );
    const { json } = await call(owner, 'PUT', '', registration());
    const refused = await call(owner, 'POST', `/${json.device.id}/test`);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('device_not_registered');
    expect(await db.pushDevices.get(json.device.id)).toMatchObject({ disabled_reason: 'device_not_registered' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND exp.host');
      }),
    );
    const second = await call(owner, 'PUT', '', registration());
    const unreachable = await call(owner, 'POST', `/${second.json.device.id}/test`);
    expect(unreachable.status).toBe(502);
    expect(unreachable.json).toMatchObject({ ok: false, code: 'send_failed' });
    expect(unreachable.json.error).toContain('exp.host');
  });
});
