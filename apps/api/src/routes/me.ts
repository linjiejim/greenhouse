/**
 * The signed-in member's own settings that follow the account across devices.
 *
 * GET   /api/me/preferences   → MemberPreferences ({ fontScale })
 * PATCH /api/me/preferences   { fontScale?: 0.8 | 0.85 | 0.9 | 1 | 1.1 | 1.2 | 1.35 } → MemberPreferences
 *
 * Stored in `users.preferences` (jsonb). Unknown keys and
 * out-of-range values are rejected; the read always returns every key with its
 * default filled in.
 *
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { memberPreferencesOf, memberPreferencesPatchSchema } from '@greenhouse/types/preferences';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';

const meRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const user = await getDb().users.getById(getAuthUser(c).id);
    if (!user) return c.json({ error: 'User not found' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json({ user: { id: user.id, name: user.nickname, role: user.role } });
  })
  .get('/preferences', async (c) => {
    const user = getAuthUser(c);
    return c.json(memberPreferencesOf(await getDb().users.getPreferences(user.id)));
  })
  .patch('/preferences', async (c) => {
    const user = getAuthUser(c);
    const parsed = memberPreferencesPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        { error: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid preferences' },
        400,
      );
    }
    const patch = parsed.data;
    const saved = await getDb().users.mutatePreferences(user.id, (current) => ({ ...current, ...patch }));
    if (!saved) return c.json({ error: 'User not found' }, 404);
    return c.json(memberPreferencesOf(saved));
  });

export default meRoutes;
