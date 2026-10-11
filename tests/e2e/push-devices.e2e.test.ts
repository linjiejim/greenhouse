/**
 * E2E — mobile push devices over real HTTP (docs/specs/20261010-mobile-push.md §3.3):
 * the routes are mounted behind the real auth middleware (no token → 401), register
 * by token, never echo the token, and unregister. The test push is not exercised here
 * (it would reach exp.host; the suite makes no real egress).
 *
 * Use `pnpm test:e2e:ci`; manual debugging setup is documented in tests/e2e/README.md.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, BASE_URL, createSuperToken } from './helpers.js';

const PROJECT = '1f49365d-7d88-472a-b196-01fcd9c428e5';
const TOKEN = `ExponentPushToken[e2e-${Date.now()}]`;
let token: string;
let deviceId: string | null = null;

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/health`).catch(() => null);
  if (!res?.ok) throw new Error(`Server not running at ${BASE_URL}. Run pnpm test:e2e:ci or follow tests/e2e/README.md.`);
  token = createSuperToken();
});

afterAll(async () => {
  if (deviceId) {
    await fetch(`${BASE_URL}/api/auth/me/push-devices/${deviceId}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }).catch(() => {});
  }
});

describe('E2E: push devices', () => {
  it('reports the deployment switch in /health', async () => {
    const health = (await (await fetch(`${BASE_URL}/health`)).json()) as { mobile_push?: { enabled: boolean } };
    expect(health.mobile_push).toEqual({ enabled: true });
  });

  it('refuses every route without a session', async () => {
    for (const [method, path] of [
      ['GET', ''],
      ['PUT', ''],
      ['PATCH', '/pdv_x'],
      ['DELETE', '/pdv_x'],
      ['POST', '/pdv_x/test'],
    ] as const) {
      const res = await fetch(`${BASE_URL}/api/auth/me/push-devices${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('registers this phone, lists it without its token, and unregisters it', async () => {
    const put = await fetch(`${BASE_URL}/api/auth/me/push-devices`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ token: TOKEN, platform: 'ios', project_id: PROJECT, client_ref: 'st-e2e' }),
    });
    expect(put.status).toBe(200);
    const registered = (await put.json()) as { enabled: boolean; device: { id: string; client_ref: string } };
    expect(registered.enabled).toBe(true);
    expect(registered.device.client_ref).toBe('st-e2e');
    deviceId = registered.device.id;

    const list = await fetch(`${BASE_URL}/api/auth/me/push-devices`, { headers: authHeaders(token) });
    const body = await list.text();
    expect(body).toContain(deviceId);
    expect(body).not.toContain(TOKEN);

    const bad = await fetch(`${BASE_URL}/api/auth/me/push-devices`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({ token: 'not-a-token', platform: 'ios', project_id: PROJECT }),
    });
    expect(bad.status).toBe(400);

    const removed = await fetch(`${BASE_URL}/api/auth/me/push-devices/${deviceId}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });
    expect(removed.status).toBe(200);
    const after = (await (await fetch(`${BASE_URL}/api/auth/me/push-devices`, { headers: authHeaders(token) })).json()) as {
      devices: Array<{ id: string }>;
    };
    expect(after.devices.map((d) => d.id)).not.toContain(deviceId);
  });
});
