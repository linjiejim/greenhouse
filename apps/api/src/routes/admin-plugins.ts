/**
 * 插件管理 — /api/admin/plugins
 * GET / — 查看编入、启用、版本、迁移及启动状态（仅 super）
 */
import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';
import { requireSuper } from '../auth/middleware.js';
import { pluginStatus } from '../plugin-host/status.js';

export default new Hono<AppEnv>()
  .use('*', requireSuper())
  .get('/', async (c) => c.json({ plugins: await pluginStatus(getDb()) }));
