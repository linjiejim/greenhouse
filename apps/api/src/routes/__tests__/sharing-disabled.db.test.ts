import { beforeEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { GREENHOUSE_CONFIG } from '../../config/greenhouse-config.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import shares from '../shares.js';
import sessions from '../sessions.js';
import { canAccessSession } from '../../sessions/access.js';
import type { AppEnv } from '../../app-env.js';
let db: DatabaseProvider;
beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
});
it('hides sharing routes, lists and access while preserving stored shares', async () => {
  const owner = await createInternalTestUser(db, { email: 'sharing-owner@test.local' });
  const viewer = await createInternalTestUser(db, { email: 'sharing-viewer@test.local' });
  const session = await db.sessions.create('Shared fixture', 'sprouty', owner.id);
  await db.sessionShares.createMany([{ session_id: session.id, shared_by: owner.id, shared_with: viewer.id }]);
  const app = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: viewer.id, role: viewer.role });
      await next();
    })
    .route('/api/shares', shares)
    .route('/api/sessions', sessions);
  const previous = GREENHOUSE_CONFIG.conversations.sharing;
  try {
    GREENHOUSE_CONFIG.conversations.sharing = false;
    expect(await (await app.request('/api/shares')).json()).toEqual({ shares: [] });
    expect((await app.request('/api/shares', { method: 'POST' })).status).toBe(404);
    expect((await app.request(`/api/sessions/${session.id}/shares`)).status).toBe(404);
    expect(await canAccessSession({ id: viewer.id, role: viewer.role }, session as never)).toBe(false);
    expect(await db.sessionShares.getSharedSessionIds(viewer.id)).toContain(session.id);
  } finally {
    GREENHOUSE_CONFIG.conversations.sharing = previous;
  }
});
