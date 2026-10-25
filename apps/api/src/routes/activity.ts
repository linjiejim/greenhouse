/**
 * Activity log 路由 — /api/activity
 *
 * GET /api/activity          — 操作记录一页：人 / 成员的 Agent / 定时任务 / 管理员改动，游标分页
 *                              （source、module、user_id、from、to、cursor、limit）
 * GET /api/activity/export   — 同样的筛选导出 CSV（最多 ACTIVITY_EXPORT_MAX_ROWS 行）
 * GET /api/activity/recent   — 铃铛里的「团队动态」：近 14 天全团队的改动，只含查看者读得到的对象（limit ≤ 50；
 *                              before=<上一页最后一条的 at> 翻页，返回 next_before，没有更多时为 null）
 *
 * 成员只看到自己的记录（user_id 被忽略）；super 看全部、可按人筛选，管理员改动只给 super。
 * 实现见 activity/activity-log.ts。
 */

import { Hono, type Context } from 'hono';
import { getDb } from '@greenhouse/db';
import { ACTIVITY_EXPORT_MAX_ROWS, type ActivityItem } from '@greenhouse/types/activity';
import type { AppEnv } from '../app-env.js';
import { getAuthUser, requireInternal } from '../auth/middleware.js';
import { contentDisposition } from '../http/content-disposition.js';
import { getPlatformRuntime } from '../platform/runtime.js';
import {
  ACTIVITY_CSV_HEADER,
  ActivityQueryError,
  activityCsvRows,
  listActivity,
  type ActivityQuery,
} from '../activity/activity-log.js';
import { listRecentChanges, RECENT_MAX_ITEMS } from '../activity/recent-changes.js';

function queryOf(c: Context<AppEnv>): ActivityQuery {
  const limit = c.req.query('limit');
  return {
    source: c.req.query('source') || null,
    module: c.req.query('module') || null,
    userId: c.req.query('user_id') || null,
    from: c.req.query('from') || null,
    to: c.req.query('to') || null,
    cursor: c.req.query('cursor') || null,
    limit: limit ? Number(limit) : null,
  };
}

const deps = () => ({ manifests: getPlatformRuntime().listManifests() });

export function createActivityRoutes() {
  return new Hono<AppEnv>()
    .use('*', requireInternal())
    .get('/', async (c) => {
      const user = getAuthUser(c);
      try {
        const page = await listActivity(getDb(), user, queryOf(c), deps());
        // Items carry recursive JSON-ish unions; keep Hono from instantiating them.
        return c.json(page as unknown as Record<string, unknown>);
      } catch (error) {
        if (error instanceof ActivityQueryError) return c.json({ error: error.message }, 400);
        throw error;
      }
    })
    .get('/recent', async (c) => {
      const user = getAuthUser(c);
      const limit = Number(c.req.query('limit') ?? '') || undefined;
      const before = c.req.query('before') || null;
      const items = await listRecentChanges(getDb(), user, { limit, before }, { runtime: getPlatformRuntime() });
      const pageSize = Math.min(Math.max(Math.trunc(limit ?? 20) || 20, 1), RECENT_MAX_ITEMS);
      const next_before = items.length >= pageSize ? (items[items.length - 1]?.at ?? null) : null;
      return c.json({ items, next_before } as unknown as Record<string, unknown>);
    })
    .get('/export', async (c) => {
      const user = getAuthUser(c);
      const query = queryOf(c);
      const rows: ActivityItem[] = [];
      let cursor = query.cursor ?? null;
      try {
        // Page through the same stream the screen shows, up to the export cap.
        while (rows.length < ACTIVITY_EXPORT_MAX_ROWS) {
          const page = await listActivity(getDb(), user, { ...query, cursor, limit: 200 }, deps());
          rows.push(...page.items);
          if (!page.next_cursor) break;
          cursor = page.next_cursor;
        }
      } catch (error) {
        if (error instanceof ActivityQueryError) return c.json({ error: error.message }, 400);
        throw error;
      }
      const body = [ACTIVITY_CSV_HEADER, ...activityCsvRows(rows.slice(0, ACTIVITY_EXPORT_MAX_ROWS))].join('\r\n');
      c.header('Content-Type', 'text/csv; charset=utf-8');
      c.header('Content-Disposition', contentDisposition('activity.csv'));
      c.header('Cache-Control', 'no-store');
      // A BOM so spreadsheet apps read the UTF-8 names correctly.
      return c.body(`\uFEFF${body}`);
    });
}
