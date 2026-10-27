/**
 * Member names for ids a client already holds — /api/people
 *
 * POST /api/people/resolve  { ids: string[] } → { people: { id, name }[] }
 *
 * Plugin records store members as ids (`user` / `users` fields); clients draw them as names
 * and fetch the names here in one batch.
 *
 * Rules:
 * - internal members only (super / team), the same people who see colleagues in member pickers;
 * - only the id and the display name come back — never email, role or status;
 * - unknown ids are left out, so the client keeps showing what it had;
 * - at most MAX_RESOLVE_PEOPLE ids per call.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '@greenhouse/db';
import type { AppEnv } from '../app-env.js';
import { requireInternal } from '../auth/middleware.js';

export const MAX_RESOLVE_PEOPLE = 200;
const resolveSchema = z.object({ ids: z.array(z.string().min(1).max(200)).max(MAX_RESOLVE_PEOPLE) });

const peopleRoutes = new Hono<AppEnv>().use('*', requireInternal()).post('/resolve', async (c) => {
  const parsed = resolveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: `ids: at most ${MAX_RESOLVE_PEOPLE} member ids` }, 400);
  const wanted = new Set(parsed.data.ids);
  const people: { id: string; name: string }[] = [];
  if (wanted.size)
    for (const user of await getDb().users.list())
      if (wanted.has(user.id) && user.nickname) people.push({ id: user.id, name: user.nickname });
  c.header('Cache-Control', 'no-store');
  return c.json({ people });
});

export default peopleRoutes;
