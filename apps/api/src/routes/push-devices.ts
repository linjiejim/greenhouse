/**
 * 手机推送设备 — /api/auth/me/push-devices（spec docs/specs/20261010-mobile-push.md §3.3）
 *
 * GET    /api/auth/me/push-devices           — 我的已注册手机 + 本部署是否开了推送（App 据此决定显示推送设置；旧服务器 404 = 不支持）
 * PUT    /api/auth/me/push-devices           — 按 token 注册 / 刷新本机（登录、启动、回前台、token 变化时调）；部署关了推送 → { device: null, enabled: false }，什么都不存
 * PATCH  /api/auth/me/push-devices/:id       — 改本机的开关（需要你 / 办完了 / 回复 / 显示内容预览 / 后台任务的 Live Activity）
 * DELETE /api/auth/me/push-devices/:id       — 注销本机（退出登录、移除工作站、关掉推送）；只停用、不删行，再注册就恢复
 * POST   /api/auth/me/push-devices/:id/test  — 立刻发一条测试推送（每台 10 秒一次），自托管者用它自检 exp.host 是否通
 *
 * 只给内部账号（requireInternal，挂在 src/index.ts）；全部按当前用户作用域，他人的设备一律 404。
 * token 只进不出：任何响应都不含 token。同一台手机换账号注册 = 这一行归新账号（偏好重置）。
 */

import { Hono, type Context } from 'hono';
import { getDb, pushDevicePrefs, type PushDeviceRow } from '@greenhouse/db';
import {
  PUSH_PREF_KEYS,
  type PushDeviceListResponse,
  type PushDeviceRegisterResponse,
  type PushDeviceView,
  type PushPrefs,
  type PushTestErrorCode,
} from '@greenhouse/types/push';
import { logger } from '@greenhouse/utils/logger';

import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { mobilePushEnabled } from '../notifications/push/config.js';
import { sendTestPush } from '../notifications/push/deliver.js';
import { InMemoryRateLimiter } from '../security/security.js';

/** `ExponentPushToken[…]` (older SDKs: `ExpoPushToken[…]`). */
const TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/;
/** An Expo project id (EAS `projectId`, a UUID). */
const PROJECT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The device's own id for this station (echoed in every push as `data.s`). */
const CLIENT_REF_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

const TEST_WINDOW_MS = 10_000;
const testLimiter = new InMemoryRateLimiter();

function iso(value: string): string {
  return new Date(value).toISOString();
}

function toView(row: PushDeviceRow): PushDeviceView {
  return {
    id: row.id,
    platform: row.platform,
    client_ref: row.client_ref,
    prefs: pushDevicePrefs(row),
    created_at: iso(row.created_at),
    last_seen_at: iso(row.last_seen_at),
  };
}

async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** `prefs` from a body: booleans for known keys only (unknown keys ignored). */
function parsePrefs(raw: unknown): { ok: true; value: Partial<PushPrefs> } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'prefs must be an object' };
  const value: Partial<PushPrefs> = {};
  for (const key of PUSH_PREF_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return { ok: false, error: `prefs.${key} must be true or false` };
    value[key] = v;
  }
  return { ok: true, value };
}

function testRefused(code: PushTestErrorCode, error: string) {
  return { ok: false as const, code, error };
}

const pushDeviceRoutes = new Hono<AppEnv>()
  // ── GET /api/auth/me/push-devices ──
  .get('/', async (c) => {
    const user = getAuthUser(c);
    const enabled = mobilePushEnabled();
    const devices = enabled ? (await getDb().pushDevices.listActiveForUser(user.id)).map(toView) : [];
    return c.json({ devices, enabled } satisfies PushDeviceListResponse);
  })

  // ── PUT /api/auth/me/push-devices — register / refresh this phone ──
  .put('/', async (c) => {
    const user = getAuthUser(c);
    if (!mobilePushEnabled()) return c.json({ device: null, enabled: false } satisfies PushDeviceRegisterResponse);
    const body = await readJson(c);
    if (typeof body.token !== 'string' || !TOKEN_PATTERN.test(body.token)) {
      return c.json({ error: 'token must be an Expo push token ("ExponentPushToken[…]")' }, 400);
    }
    if (body.platform !== 'ios') return c.json({ error: 'platform must be "ios"' }, 400);
    if (typeof body.project_id !== 'string' || !PROJECT_PATTERN.test(body.project_id)) {
      return c.json({ error: "project_id must be the app's Expo project id (a UUID)" }, 400);
    }
    const clientRef = body.client_ref ?? null;
    if (clientRef !== null && (typeof clientRef !== 'string' || !CLIENT_REF_PATTERN.test(clientRef))) {
      return c.json({ error: 'client_ref must be 1–64 characters of A-Z a-z 0-9 . _ : -' }, 400);
    }
    const prefs = parsePrefs(body.prefs);
    if (!prefs.ok) return c.json({ error: prefs.error }, 400);

    const db = getDb();
    const account = await db.users.getById(user.id);
    if (!account) return c.json({ error: 'User not found' }, 404);
    const { device } = await db.pushDevices.register({
      user_id: user.id,
      token: body.token,
      platform: 'ios',
      project_id: body.project_id.toLowerCase(),
      client_ref: clientRef,
      prefs: prefs.value,
      auth_version: account.auth_version,
    });
    return c.json({ device: toView(device), enabled: true } satisfies PushDeviceRegisterResponse);
  })

  // ── PATCH /api/auth/me/push-devices/:id — change this phone's switches ──
  .patch('/:id', async (c) => {
    const user = getAuthUser(c);
    const body = await readJson(c);
    const prefs = parsePrefs(body.prefs);
    if (!prefs.ok) return c.json({ error: prefs.error }, 400);
    if (Object.keys(prefs.value).length === 0) return c.json({ error: 'Nothing to change — send prefs' }, 400);
    const device = await getDb().pushDevices.updatePrefs(user.id, c.req.param('id'), prefs.value);
    if (!device) return c.json({ error: `Push device not found (ID: "${c.req.param('id')}")` }, 404);
    return c.json({ device: toView(device) });
  })

  // ── DELETE /api/auth/me/push-devices/:id — unregister this phone ──
  .delete('/:id', async (c) => {
    const user = getAuthUser(c);
    const ok = await getDb().pushDevices.unregister(user.id, c.req.param('id'));
    if (!ok) return c.json({ error: `Push device not found (ID: "${c.req.param('id')}")` }, 404);
    return c.json({ ok: true as const });
  })

  // ── POST /api/auth/me/push-devices/:id/test — one test push, now ──
  .post('/:id/test', async (c) => {
    const user = getAuthUser(c);
    const id = c.req.param('id');
    if (!mobilePushEnabled()) {
      return c.json(
        testRefused('push_disabled', 'Pushes are switched off on this deployment (MOBILE_PUSH_ENABLED)'),
        503,
      );
    }
    const db = getDb();
    const device = await db.pushDevices.getForUser(user.id, id);
    if (!device) return c.json({ error: `Push device not found (ID: "${id}")` }, 404);
    if (device.disabled_at) return c.json(testRefused('device_disabled', 'This device is unregistered'), 409);
    const limit = testLimiter.check(`push-test:${device.id}`, TEST_WINDOW_MS, 1);
    if (!limit.allowed) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))));
      return c.json(testRefused('too_soon', 'One test every 10 seconds per device'), 429);
    }
    const account = await db.users.getById(user.id);
    if (!account) return c.json({ error: 'User not found' }, 404);
    const outcome = await sendTestPush(device, account);
    if (outcome.status === 'ok') return c.json({ ok: true as const });
    if (outcome.status === 'error' && outcome.code === 'DeviceNotRegistered') {
      await db.pushDevices.disable(device.id, 'device_not_registered');
      return c.json(testRefused('device_not_registered', 'The app is no longer registered on this phone'), 409);
    }
    const error = outcome.status === 'error' ? `${outcome.code ?? 'error'}: ${outcome.message}` : outcome.error;
    logger.warn('[push] test push failed', { deviceId: device.id, error });
    return c.json(testRefused('send_failed', error), 502);
  });

export default pushDeviceRoutes;
