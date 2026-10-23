/**
 * 模块用量计数 — /api/usage
 *
 * POST /api/usage/page-open  — 记一次页面打开 {module}（内部用户；client 取 X-Greenhouse-Client：mobile，缺省 web）
 * GET  /api/usage/spend?month=YYYY-MM — 本人当月花费（按服务 / 客户端 / Agent 客户端）与本人额度（只看自己的）
 *
 * module 只能是 @greenhouse/types/usage 的 PAGE_MODULE_IDS 或当前启用扩展的 `ext.<id>`，
 * 其余一律 400，客户端写不进任意 key。只计数：不记用户、不记内容。
 * 读侧在 GET /api/admin/usage/modules（super only，routes/admin.ts）。
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getDb } from '@greenhouse/db';
import { isPageModuleId } from '@greenhouse/types/usage';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { EXTENSIONS } from '../extensions/index.js';
import { pageOpenClient, requestAppClient } from '../usage/counters.js';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { buildMySpend, parseMonth } from '../usage/report.js';

/** Module ids a page open may name on this deployment. */
function activeExtensionIds(): string[] {
  return EXTENSIONS.map((ext) => ext.id);
}

const usage = new Hono<AppEnv>()
  /** POST /page-open — one open of one module */
  .post('/page-open', bodyLimit({ maxSize: 1024 }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const module = body && typeof body === 'object' ? (body as { module?: unknown }).module : undefined;
    if (!isPageModuleId(module, activeExtensionIds())) {
      return c.json({ error: 'Unknown module' }, 400);
    }
    const client = pageOpenClient(requestAppClient(c));
    try {
      await getDb().usageCounters.increment('page_open', module, client);
    } catch (err) {
      // A lost count is not the viewer's problem; the page already opened.
      logger.warn(`[usage] could not count page_open ${module} (${client}): ${toErrorMessage(err)}`);
    }
    return c.json({ ok: true as const }, 202);
  })
  /** GET /spend — the caller's own month; never anyone else's */
  .get('/spend', async (c) => {
    const at = parseMonth(c.req.query('month'));
    if (!at) return c.json({ error: 'month must be YYYY-MM' }, 400);
    return c.json(await buildMySpend(getDb(), getAuthUser(c).id, at));
  });

export default usage;
