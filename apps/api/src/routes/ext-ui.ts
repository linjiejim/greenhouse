/**
 * 内嵌插件凭证
 * POST /api/ext-ui/token { plugin } — 签发十分钟、绑定当前成员的插件令牌
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getDb } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';
import { getAuthUser, requireInternal } from '../auth/middleware.js';
import { createExtUiToken } from '../auth/token.js';
import { memberCanUsePlugin } from '../extensions/ui-access.js';

export default new Hono<AppEnv>()
  .use('*', requireInternal())
  .use('*', bodyLimit({ maxSize: 4096 }))
  .post('/token', async (c) => {
    c.header('Cache-Control', 'no-store');
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.plugin !== 'string' || !/^[a-z][a-z0-9-]*$/.test(body.plugin))
      return c.json({ error: 'Invalid plugin' }, 400);
    const user = getAuthUser(c),
      db = getDb();
    if (!(await memberCanUsePlugin(db, user, body.plugin))) return c.json({ error: 'Plugin unavailable' }, 403);
    const current = await db.users.getById(user.id);
    if (!current || current.status !== 'active') return c.json({ error: 'Account unavailable' }, 401);
    return c.json(createExtUiToken(user.id, user.role, current.auth_version, body.plugin));
  });
