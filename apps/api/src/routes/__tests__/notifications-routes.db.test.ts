/** Platform notification HTTP ownership and cursor integration tests. */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import type { AppEnv } from '../../app-env.js';
import { createNotificationRoutes } from '../notifications.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let other: UserRow;

function createApp(users: UserRow[]) {
  const byId = new Map(users.map((user) => [user.id, user]));
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = byId.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/notifications', createNotificationRoutes());
  return app;
}

describe('platform notification routes', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `notification-route-owner-${Date.now()}@test.local` });
    other = await createInternalTestUser(db, { email: `notification-route-other-${Date.now()}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('returns only the authenticated inbox and never lets another user mark an item read', async () => {
    const notification = await db.notifications.create({
      user_id: owner.id,
      kind: 'runtime_attention',
      title: 'Approval required',
      body: 'Review exact parameters.',
      payload: { full: { parameters: ['one', 'two'] } },
      dedupe_key: `route:${Date.now()}:${Math.random()}`,
    });
    const app = createApp([owner, other]);

    const ownerList = await app.request('/api/notifications', { headers: { 'x-test-user': owner.id } });
    expect(ownerList.status).toBe(200);
    expect((await ownerList.json()).notifications).toEqual([
      expect.objectContaining({ id: notification.id, payload: { full: { parameters: ['one', 'two'] } } }),
    ]);

    const otherList = await app.request('/api/notifications', { headers: { 'x-test-user': other.id } });
    expect((await otherList.json()).notifications).toEqual([]);
    const denied = await app.request(`/api/notifications/${notification.id}/read`, {
      method: 'POST',
      headers: { 'x-test-user': other.id },
    });
    expect(denied.status).toBe(404);
    expect(await db.notifications.countUnread(owner.id)).toBe(1);

    const marked = await app.request(`/api/notifications/${notification.id}/read`, {
      method: 'POST',
      headers: { 'x-test-user': owner.id },
    });
    expect(marked.status).toBe(200);
    expect((await marked.json()).notification.read_at).toEqual(expect.any(String));
    expect((await app.request('/api/notifications/summary', { headers: { 'x-test-user': owner.id } })).status).toBe(
      200,
    );
  });

  it('rejects malformed cursors and limits instead of silently changing pagination', async () => {
    const app = createApp([owner]);
    expect(
      (await app.request('/api/notifications?cursor=not-a-cursor', { headers: { 'x-test-user': owner.id } })).status,
    ).toBe(400);
    expect((await app.request('/api/notifications?limit=101', { headers: { 'x-test-user': owner.id } })).status).toBe(
      400,
    );
  });
});
