/** POST /api/admin/retro — generate this month's review (super only). */
import { Hono } from 'hono';
import { getAuthUser, getDb, type AppEnv } from '@greenhouse/api/extension-kit';
import type { RetroResult } from '@greenhouse/types/hub-context';
import { generateMonthlyRetro, RetroInputError } from './generate.js';
const routes = new Hono<AppEnv>().post('/', async (c) => {
  const user = getAuthUser(c);
  const body = (await c.req.json().catch(() => ({}))) as { month?: unknown };
  if (body.month !== undefined && typeof body.month !== 'string') {
    return c.json({ error: 'month must be YYYY-MM' }, 400);
  }
  try {
    const result: RetroResult = await generateMonthlyRetro({
      db: getDb(),
      ...(typeof body.month === 'string' ? { month: body.month } : {}),
      actorId: user.id,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof RetroInputError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

export default routes;
