/**
 * Bot 电脑路由 — 成员自己的电脑 + 管理员视图 + 实时画面 / 终端
 *
 * /api/bots/computer（requireInternal + requireFeature('bots')，只操作当前成员自己的电脑）
 * GET  /api/bots/computer                  — 电脑状态（运行时、状态、谁在操作、排队位置、磁盘、时区、浏览器语言）
 * POST /api/bots/computer/start            — 启动并等就绪（含排队，最长约 45s + 45s）
 * POST /api/bots/computer/stop             — 停止（文件与登录态保留）
 * POST /api/bots/computer/reset            — 重建 {wipe_data?}：删容器用当前镜像重建；wipe_data 同时清空数据
 * PUT  /api/bots/computer/settings         — 成员设置 {timezone}：IANA 时区（null = 部署默认），下次启动生效
 * POST /api/bots/computer/view-token       — 实时画面一次性票据（60s，绑定成员 + auth_version + 容器）
 * POST /api/bots/computer/terminal-token   — 终端一次性票据（同上；与画面票据互不通用）
 * POST /api/bots/computer/takeover         — 接管屏幕与输入（中止 Bot 在途操作，结束 agent 进程但保留后台任务与终端）
 * POST /api/bots/computer/handback         — 交还 {note?, request_id?, session_id?}：释放租约并找回浏览器窗口；结清
 *                                            request_id 指定的卡片（或 session_id 会话里唯一一张待办的接管/登录卡）并唤醒
 *                                            发起的 Bot；都没有 = 只释放
 * POST /api/bots/computer/restore-window   — 找回浏览器窗口（最小化或关掉后；没有就新开一个）；未运行时 409 stopped
 * POST /api/bots/computer/type             — 输入文字 {text}（仅接管中；写入焦点输入框，中文可用，不落日志）
 * GET  /api/bots/computer/screenshot       — 整个桌面的 PNG（不会唤醒电脑，也不算活动；未运行时 409 stopped）
 * GET  /api/bots/computer/files?path=      — 列目录（默认 ~/work；≤500 条，目录在前再按名称；truncated = 还有更多）
 * GET  /api/bots/computer/files/download?path= — 下载文件（流式；仅普通文件，≤1 GiB）
 * POST /api/bots/computer/files/upload?dir=&name= — 上传（原始请求体，≤100 MiB；dir 默认 ~/work；重名存成 `名 (1).扩展名`）
 * GET  /api/bots/computer/processes        — 后台任务（gh-jobs）列表；电脑没在运行时为空（不会唤醒电脑）
 * GET  /api/bots/computer/processes/:id/log?lines= — 任务日志尾部（默认 200 行，≤2000；已打码）
 * POST /api/bots/computer/processes/:id/stop — 停止任务（SIGTERM，3s 后 SIGKILL）
 *
 * 文件、终端都以 uid agent 运行，路径限定在 /home/agent（`~` = /home/agent，相对路径 = ~/work），会按需启动电脑
 * （超出软磁盘上限也可以，方便清理）并算作活动。
 *
 * /api/admin/bot-computers（requireSuper）
 * GET  /api/admin/bot-computers                 — 运行时、预检清单（含修复命令）、每台电脑、旋钮
 * POST /api/admin/bot-computers/:userId/stop    — 停止某成员的电脑
 * POST /api/admin/bot-computers/:userId/backup  — 立即备份（休眠中的先唤醒，备份在后台进行；未开备份 → 503 disabled）
 * POST /api/admin/bot-computers/:userId/reset   — 重置 {wipe_data?}（不代为重启，成员下次使用时自动启动；
 *                                                 清空数据时宿主不可用返回 503 unavailable，绝不假装已清空）
 *
 * WS /api/ws/computer?token= — see viewer.ts; WS /api/ws/computer-terminal?token= — see terminal.ts.
 *
 * Errors carry `{ error, code }`; `code` is a ComputerUnavailableError code
 * (disabled | unavailable | busy | start_failed | user_in_control | stopped |
 * over_quota) or `lease_required` / `invalid`; files and processes add
 * `not_found` (404) and `too_large` (413). `over_quota` adds
 * `reason: 'host_disk'` when the Docker host's disk is nearly full (an
 * admin's job) rather than the member's own home.
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §6.4,
 * docs/specs/20261007-bots-computer-p0-p1.md §2; HTTP contract in ../AGENTS.md.
 */

import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { validator } from 'hono/validator';
import { z } from 'zod';
import { getDb } from '@greenhouse/db';
import type { ComputerStatusView } from '@greenhouse/types/bots';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

import type { AppEnv } from '../../app-env.js';
import { getAuthUser } from '../../auth/middleware.js';
import { safeDriveContentType } from '../../drive/upload-policy.js';
import { contentDisposition } from '../../http/content-disposition.js';
import { captureDesktop, redactFilledSecrets, restoreBrowserWindow } from './access.js';
import { parseTimezone, TIMEZONE_MAX_CHARS } from './config.js';
import { ComputerDockerError, ComputerRuntimeError } from './docker.js';
import { ComputerUnavailableError } from './errors.js';
import {
  ComputerFileError,
  listComputerFiles,
  openComputerDownload,
  uploadComputerFile,
  UPLOAD_MAX_BYTES,
  type ComputerDownload,
} from './files.js';
import { jobLog, listJobs, stopJob } from './jobs.js';
import { handbackComputer, LeaseRequiredError, takeoverComputer, typeIntoFocusedField } from './lease.js';
import { computerContainerName, computerIdentity } from './namespace.js';
import {
  adminComputersView,
  backupComputerNow,
  computerNamespace,
  computerStatusFor,
  purgeUserComputer,
  requireComputerRuntime,
  stopUserComputer,
} from './runtime.js';
import {
  createViewToken,
  TERMINAL_TOKEN_PURPOSE,
  VIEW_TOKEN_PURPOSE,
  type ComputerTicketPurpose,
} from './view-token.js';

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
/** IANA name (validated by parseTimezone) or null = back to the deployment default. */
const settingsSchema = z.object({ timezone: z.string().max(TIMEZONE_MAX_CHARS).nullable() }).strict();
const PATH_MAX = 4096;
const filesQuery = z.object({ path: z.string().max(PATH_MAX).optional() });
const downloadQuery = z.object({ path: z.string().min(1).max(PATH_MAX) });
const uploadQuery = z.object({ dir: z.string().max(PATH_MAX).optional(), name: z.string().min(1).max(1024) });
const logQuery = z.object({
  lines: z
    .string()
    .regex(/^\d{1,5}$/)
    .optional(),
});

const UNAVAILABLE_STATUS = {
  disabled: 503,
  unavailable: 503,
  busy: 503,
  start_failed: 502,
  user_in_control: 409,
  stopped: 409,
  over_quota: 409,
} as const;

const FILE_ERROR_STATUS = { invalid: 400, not_found: 404, too_large: 413 } as const;

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

/** Files: what the member asked for is wrong (400 / 404 / 413), else the computer's errors. */
function fileError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof ComputerFileError) {
    return c.json({ error: err.message, code: err.code }, FILE_ERROR_STATUS[err.code]);
  }
  return computerError(c, err);
}

/** Processes: an unknown job id is a 404, else the computer's errors. */
function processError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof ComputerDockerError && err.code === 'not_found') {
    return c.json({ error: err.message, code: 'not_found' as const }, 404);
  }
  return computerError(c, err);
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
const INVALID_QUERY = { error: 'Invalid query', code: 'invalid' } as const;

/** A zod schema as the query validator (the typed client sees the parameters). */
function queryOf<T extends z.ZodType>(schema: T) {
  return validator('query', (value, c) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data as z.output<T>) : c.json(INVALID_QUERY, 400);
  });
}

/** A zod schema as the JSON body validator (the typed client sees the body). */
function jsonOf<T extends z.ZodType>(schema: T) {
  return validator('json', (value, c) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data as z.output<T>) : c.json(INVALID, 400);
  });
}

/** A one-time ticket for one of the computer's sockets (viewer or terminal), bound to the member's container. */
async function socketTicket(c: Context<AppEnv>, purpose: ComputerTicketPurpose) {
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
  return c.json(createViewToken({ id: user.id, authVersion: account.auth_version }, container, { purpose }));
}

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
    .put('/settings', jsonOf(settingsSchema), async (c) => {
      const user = getAuthUser(c);
      const { timezone } = c.req.valid('json');
      const zone = timezone === null ? null : parseTimezone(timezone);
      if (timezone !== null && !zone) return c.json({ error: 'Not an IANA time zone', code: 'invalid' as const }, 400);
      // Only the row is written (the next start applies it), so a host that is
      // down right now does not matter — computers being off does.
      const namespace = computerNamespace();
      if (!namespace) {
        return c.json({ error: 'The computer is not enabled on this deployment', code: 'disabled' as const }, 503);
      }
      await getDb().botComputers.setTimezone(computerIdentity(namespace, user.id), zone);
      return c.json(await computerStatusFor(user.id));
    })
    .post('/view-token', (c) => socketTicket(c, VIEW_TOKEN_PURPOSE))
    .post('/terminal-token', (c) => socketTicket(c, TERMINAL_TOKEN_PURPOSE))
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
    .post('/restore-window', async (c) => {
      const user = getAuthUser(c);
      try {
        await restoreBrowserWindow(user.id);
      } catch (err) {
        return computerError(c, err);
      }
      return c.json({ ok: true as const });
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
    })
    .get('/files', queryOf(filesQuery), async (c) => {
      const user = getAuthUser(c);
      try {
        return c.json(await listComputerFiles(user.id, c.req.valid('query').path));
      } catch (err) {
        return fileError(c, err);
      }
    })
    .get('/files/download', queryOf(downloadQuery), async (c) => {
      const user = getAuthUser(c);
      let download: ComputerDownload;
      try {
        download = await openComputerDownload(user.id, c.req.valid('query').path);
      } catch (err) {
        return fileError(c, err);
      }
      return c.body(download.stream, 200, {
        // By extension, from a small safe set (anything else is octet-stream):
        // the bytes come from the computer — the internet, as far as we know.
        'Content-Type': safeDriveContentType(download.name),
        'Content-Length': String(download.size),
        'Content-Disposition': contentDisposition(download.name),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
    })
    .post(
      '/files/upload',
      queryOf(uploadQuery),
      // A declared length over the cap is refused before a byte is read; a
      // chunked body is read up to the cap at most.
      bodyLimit({
        maxSize: UPLOAD_MAX_BYTES,
        onError: (c) => c.json({ error: 'Files up to 100 MiB can be uploaded', code: 'too_large' as const }, 413),
      }),
      async (c) => {
        const user = getAuthUser(c);
        const { dir, name } = c.req.valid('query');
        const declared = c.req.header('content-length');
        let body: Readable | Buffer;
        let size: number;
        if (declared && /^\d+$/.test(declared) && !c.req.header('transfer-encoding') && c.req.raw.body) {
          // Streamed into the container as it arrives; the length tells the
          // computer when the file is complete (a cut-off upload keeps nothing).
          size = Number(declared);
          body = Readable.fromWeb(c.req.raw.body as NodeReadableStream<Uint8Array>);
        } else {
          const bytes = Buffer.from(await c.req.arrayBuffer());
          body = bytes;
          size = bytes.length;
        }
        try {
          return c.json(await uploadComputerFile(user.id, { dir, name, body, size }));
        } catch (err) {
          return fileError(c, err);
        }
      },
    )
    .get('/processes', async (c) => {
      const user = getAuthUser(c);
      try {
        return c.json({ processes: await listJobs(user.id) });
      } catch (err) {
        return processError(c, err);
      }
    })
    .get('/processes/:id/log', queryOf(logQuery), async (c) => {
      const user = getAuthUser(c);
      const { lines } = c.req.valid('query');
      try {
        const log = await jobLog(user.id, c.req.param('id'), lines ? { lines: Number(lines) } : {});
        // A job's output can echo whatever a vault fill typed into a page.
        return c.json({ id: log.id, text: redactFilledSecrets(user.id, log.text), truncated: log.truncated });
      } catch (err) {
        return processError(c, err);
      }
    })
    .post('/processes/:id/stop', async (c) => {
      const user = getAuthUser(c);
      try {
        return c.json(await stopJob(user.id, c.req.param('id')));
      } catch (err) {
        return processError(c, err);
      }
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
    })
    .post('/:userId/backup', async (c) => {
      try {
        await backupComputerNow(c.req.param('userId'));
      } catch (err) {
        return computerError(c, err);
      }
      return c.json({ ok: true as const }, 202);
    });
}
