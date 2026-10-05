/**
 * Bot 电脑路由 — 成员自己的电脑 + 管理员视图 + 实时画面
 *
 * /api/bots/computer（requireInternal + requireFeature('bots')，只操作当前成员自己的电脑）
 * GET  /api/bots/computer             — 电脑状态（运行时、状态、谁在操作、排队位置、磁盘）
 * POST /api/bots/computer/start       — 启动并等就绪（含排队，最长约 45s + 45s）
 * POST /api/bots/computer/stop        — 停止（文件与登录态保留）
 * POST /api/bots/computer/reset       — 重建 {wipe_data?}：删容器用当前镜像重建；wipe_data 同时清空数据
 * POST /api/bots/computer/view-token  — 实时画面一次性票据（60s，绑定成员 + auth_version + 容器）
 * POST /api/bots/computer/takeover    — 接管屏幕与输入（中止 Bot 在途操作）
 * POST /api/bots/computer/handback    — 交还 {note?, request_id?, session_id?}：释放租约；结清 request_id 指定的卡片
 *                                       （或 session_id 会话里唯一一张待办的接管/登录卡）并唤醒发起的 Bot；都没有 = 只释放
 * POST /api/bots/computer/type        — 输入文字 {text}（仅接管中；写入焦点输入框，中文可用，不落日志）
 * GET  /api/bots/computer/screenshot  — 整个桌面的 PNG（不会唤醒电脑，也不算活动；未运行时 409 stopped）
 *
 * /api/admin/bot-computers（requireSuper）
 * GET  /api/admin/bot-computers                 — 运行时、预检清单（含修复命令）、每台电脑、旋钮
 * POST /api/admin/bot-computers/:userId/stop    — 停止某成员的电脑
 * POST /api/admin/bot-computers/:userId/reset   — 重置 {wipe_data?}（不代为重启，成员下次使用时自动启动；
 *                                                 清空数据时宿主不可用返回 503 unavailable，绝不假装已清空）
 *
 * WS /api/ws/computer?token= — see viewer.ts.
 *
 * Errors carry `{ error, code }`; `code` is a ComputerUnavailableError code
 * (disabled | unavailable | busy | start_failed | user_in_control | stopped |
 * over_quota) or `lease_required` / `invalid`. `over_quota` adds
 * `reason: 'host_disk'` when the Docker host's disk is nearly full (an
 * admin's job) rather than the member's own home.
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §6.4; HTTP contract in ../AGENTS.md.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getDb } from '@greenhouse/db';
import type { ComputerStatusView } from '@greenhouse/types/bots';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

import type { AppEnv } from '../../app-env.js';
import { getAuthUser } from '../../auth/middleware.js';
import { captureDesktop } from './access.js';
import { ComputerDockerError, ComputerRuntimeError } from './docker.js';
import { ComputerUnavailableError } from './errors.js';
import { handbackComputer, LeaseRequiredError, takeoverComputer, typeIntoFocusedField } from './lease.js';
import { computerContainerName } from './namespace.js';
import {
  adminComputersView,
  computerStatusFor,
  purgeUserComputer,
  requireComputerRuntime,
  stopUserComputer,
} from './runtime.js';
import { createViewToken } from './view-token.js';

export { createComputerViewerRoutes } from './viewer.js';

const resetSchema = z.object({ wipe_data: z.boolean().optional() }).strict();
const handbackSchema = z
  .object({
    note: z.string().max(2000).optional(),
    request_id: z.string().max(64).optional(),
    session_id: z.string().max(64).optional(),
  })
  .strict();
const typeSchema = z.object({ text: z.string().min(1).max(10_000) }).strict();

const UNAVAILABLE_STATUS = {
  disabled: 503,
  unavailable: 503,
  busy: 503,
  start_failed: 502,
  user_in_control: 409,
  stopped: 409,
  over_quota: 409,
} as const;

function computerError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof ComputerUnavailableError) {
    if (err.code === 'busy') c.header('Retry-After', '30');
    return c.json(
      { error: err.message, code: err.code, ...(err.reason ? { reason: err.reason } : {}) },
      UNAVAILABLE_STATUS[err.code],
    );
  }
  // A docker failure outside a start (a wipe, a stop): the details stay in the log.
  if (err instanceof ComputerRuntimeError || err instanceof ComputerDockerError) {
    logger.warn('[bots-computer] computer operation failed', { path: c.req.path, error: toErrorMessage(err) });
    return c.json({ error: 'The computer host could not complete this; try again later', code: 'unavailable' }, 503);
  }
  throw err;
}

async function readBody<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T | null> {
  // An empty body is an empty object: `{ wipe_data }`, `{ note }` are all optional.
  const raw = await c.req.text();
  let json: unknown = {};
  if (raw.trim()) {
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

const INVALID = { error: 'Invalid request body', code: 'invalid' } as const;

/** /api/bots/computer — the member's own computer. */
export function createBotsComputerRoutes() {
  return new Hono<AppEnv>()
    .get('/', async (c) => {
      const user = getAuthUser(c);
      const status: ComputerStatusView = await computerStatusFor(user.id);
      return c.json(status);
    })
    .post('/start', async (c) => {
      const user = getAuthUser(c);
      try {
        await requireComputerRuntime().controller.ensureRunning(user.id, { allowOverQuota: true });
      } catch (err) {
        return computerError(c, err);
      }
      return c.json(await computerStatusFor(user.id));
    })
    .post('/stop', async (c) => {
      const user = getAuthUser(c);
      await stopUserComputer(user.id, 'user');
      return c.json(await computerStatusFor(user.id));
    })
    .post('/reset', async (c) => {
      const user = getAuthUser(c);
      const body = await readBody(c, resetSchema);
      if (!body) return c.json(INVALID, 400);
      try {
        await requireComputerRuntime().controller.reset(user.id, { wipe: body.wipe_data === true });
      } catch (err) {
        return computerError(c, err);
      }
      return c.json(await computerStatusFor(user.id));
    })
    .post('/view-token', async (c) => {
      const user = getAuthUser(c);
      let namespace: string;
      try {
        namespace = requireComputerRuntime().config.namespace;
      } catch (err) {
        return computerError(c, err);
      }
      const db = getDb();
      const [account, row] = await Promise.all([db.users.getById(user.id), db.botComputers.get(user.id)]);
      if (!account) return c.json({ error: 'Unauthorized', code: 'invalid' }, 401);
      const container = row?.container_name ?? computerContainerName(namespace, user.id);
      return c.json(createViewToken({ id: user.id, authVersion: account.auth_version }, container));
    })
    .post('/takeover', async (c) => {
      const user = getAuthUser(c);
      try {
        await takeoverComputer(user.id);
      } catch (err) {
        return computerError(c, err);
      }
      return c.json(await computerStatusFor(user.id));
    })
    .post('/handback', async (c) => {
      const user = getAuthUser(c);
      const body = await readBody(c, handbackSchema);
      if (!body) return c.json(INVALID, 400);
      await handbackComputer(user.id, { note: body.note, requestId: body.request_id, sessionId: body.session_id });
      return c.json(await computerStatusFor(user.id));
    })
    .post('/type', async (c) => {
      const user = getAuthUser(c);
      const body = await readBody(c, typeSchema);
      if (!body) return c.json(INVALID, 400);
      try {
        await typeIntoFocusedField(user.id, body.text);
      } catch (err) {
        if (err instanceof LeaseRequiredError) return c.json({ error: err.message, code: 'lease_required' }, 409);
        return computerError(c, err);
      }
      return c.json({ ok: true as const });
    })
    .get('/screenshot', async (c) => {
      const user = getAuthUser(c);
      let png: Buffer;
      try {
        png = await captureDesktop(user.id);
      } catch (err) {
        return computerError(c, err);
      }
      return c.body(new Uint8Array(png), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    });
}

/** /api/admin/bot-computers — super only. */
export function createAdminBotComputerRoutes() {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await adminComputersView()))
    .post('/:userId/stop', async (c) => {
      await stopUserComputer(c.req.param('userId'), 'admin');
      return c.json({ ok: true as const });
    })
    .post('/:userId/reset', async (c) => {
      const body = await readBody(c, resetSchema);
      if (!body) return c.json(INVALID, 400);
      const userId = c.req.param('userId');
      try {
        if (body.wipe_data) await purgeUserComputer(userId, { wipe: true, reason: 'reset' });
        else await stopUserComputer(userId, 'reset');
      } catch (err) {
        return computerError(c, err);
      }
      return c.json({ ok: true as const });
    });
}
