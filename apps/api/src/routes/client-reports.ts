/**
 * 客户端错误报告 — /api/client-reports 与 /api/admin/client-reports
 *
 * POST /api/client-reports                     — 成员的 App 交来本机记下的错误（≤20 条、≤64KB 一批；每人 10 分钟 20 批）
 * GET  /api/admin/client-reports?days=7|30|90  — super：窗口内的报告按错误分组（名称 + 归一化消息），带次数、人数、平台、版本与最新一条
 *
 * 只收错误本身：名称、消息、调用栈、路由路径、App 版本 / 构建、平台 / 系统版本、工作站 API 级别。
 * 文本在设备上脱敏一次，这里用同一个 `parseClientReport`（@greenhouse/types/client-reports）再脱敏、截断一次；
 * 不是报告的条目丢掉、其余照存，同一成员重发的同一 id 只存一次。保留 90 天、最多 10,000 行（db.retention）。
 * POST 挂 requireInternal，GET 在 `/api/admin/*` 的 requireSuper 之后（src/index.ts）。
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getDb } from '@greenhouse/db';
import {
  CLIENT_REPORT_DAYS,
  CLIENT_REPORT_LIMITS,
  parseClientReport,
  type ClientErrorReport,
  type ClientReport,
  type ClientReportAccepted,
  type ClientReportDays,
} from '@greenhouse/types/client-reports';

import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { checkRateLimit } from '../security/security.js';

/** Batches one member may send per window: a crash loop must not turn into a write loop. */
export const CLIENT_REPORT_RATE = { windowMs: 10 * 60_000, max: 20 } as const;

export const clientReportRoutes = new Hono<AppEnv>()
  /** POST / — one batch of this member's reports */
  .post(
    '/',
    bodyLimit({
      maxSize: CLIENT_REPORT_LIMITS.bodyBytes,
      onError: (c) => c.json({ error: 'Report batch too large' }, 413),
    }),
    async (c) => {
      const user = getAuthUser(c);
      const limit = await checkRateLimit(
        `client-reports:${user.id}`,
        CLIENT_REPORT_RATE.windowMs,
        CLIENT_REPORT_RATE.max,
      );
      if (!limit.allowed) return c.json({ error: 'Too many reports. Please try again later.' }, 429);
      const body: unknown = await c.req.json().catch(() => null);
      const entries =
        body && typeof body === 'object' && !Array.isArray(body) ? (body as { reports?: unknown }).reports : undefined;
      if (!Array.isArray(entries) || entries.length === 0) {
        return c.json({ error: 'reports must be a non-empty list' }, 400);
      }
      if (entries.length > CLIENT_REPORT_LIMITS.batch) {
        return c.json({ error: `At most ${CLIENT_REPORT_LIMITS.batch} reports per request` }, 400);
      }
      const reports = entries.map(parseClientReport).filter((report): report is ClientReport => report !== null);
      const saved = await getDb().clientReports.record(user.id, reports);
      const accepted: ClientReportAccepted = { ...saved, rejected: entries.length - reports.length };
      return c.json(accepted, 202);
    },
  );

export const adminClientReportRoutes = new Hono<AppEnv>()
  /** GET / — grouped reports of the last `days` */
  .get('/', async (c) => {
    const days = Number(c.req.query('days') ?? '30');
    if (!(CLIENT_REPORT_DAYS as readonly number[]).includes(days)) {
      return c.json({ error: `days must be one of ${CLIENT_REPORT_DAYS.join(', ')}` }, 400);
    }
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const { total, groups } = await getDb().clientReports.summarize(since);
    const report: ClientErrorReport = { days: days as ClientReportDays, total, groups };
    return c.json(report);
  });
