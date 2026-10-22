/** Custom Agent team availability over HTTP: private by default, super-only sharing (v1.4). */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import type { AppEnv } from '../../app-env.js';
import profiles from '../profiles.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let reader: UserRow;
let admin: UserRow;

function createApp(users: UserRow[]) {
  const byId = new Map(users.map((user) => [user.id, user]));
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = byId.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/profiles', profiles);
  return app;
}

function as(user: UserRow, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { 'content-type': 'application/json', 'x-test-user': user.id, ...(init.headers ?? {}) },
  };
}

describe('custom Agent team availability routes', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    const stamp = `${Date.now()}-${Math.random()}`;
    owner = await createInternalTestUser(db, { email: `agent-share-owner-${stamp}@test.local` });
    reader = await createInternalTestUser(db, { email: `agent-share-reader-${stamp}@test.local` });
    admin = await createInternalTestUser(db, { email: `agent-share-admin-${stamp}@test.local`, role: 'super' });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('keeps an Agent private until a super shares it, and keeps it shared across edits', async () => {
    const app = createApp([owner, reader, admin]);
    const body = { name: `Share test ${Date.now()}`, system_prompt: 'Answer from the knowledge base.', tools: [] };

    const refused = await app.request(
      '/api/profiles/custom',
      as(owner, { method: 'POST', body: JSON.stringify({ ...body, is_shared: true }) }),
    );
    expect(refused.status).toBe(400);

    const created = await app.request(
      '/api/profiles/custom',
      as(owner, { method: 'POST', body: JSON.stringify(body) }),
    );
    expect(created.status).toBe(201);
    const agent = (await created.json()) as { id: string; is_shared: boolean };
    expect(agent).toMatchObject({ is_shared: false, current_version: 1 });
    expect(agent).not.toHaveProperty('lifecycle_status');
    const numericId = agent.id.replace('custom:', '');

    const readerList = async () =>
      ((await (await app.request('/api/profiles/custom', as(reader))).json()) as { profiles: Array<{ id: string }> })
        .profiles;
    expect((await readerList()).some((p) => p.id === agent.id)).toBe(false);

    const ownerShare = await app.request(
      `/api/profiles/custom/${numericId}/sharing`,
      as(owner, { method: 'PUT', body: JSON.stringify({ is_shared: true }) }),
    );
    expect(ownerShare.status).toBe(403);

    const adminShare = await app.request(
      `/api/profiles/custom/${numericId}/sharing`,
      as(admin, { method: 'PUT', body: JSON.stringify({ is_shared: true }) }),
    );
    expect(adminShare.status).toBe(200);
    expect(await adminShare.json()).toMatchObject({ id: agent.id, is_shared: true });
    expect((await readerList()).some((p) => p.id === agent.id)).toBe(true);

    const edited = await app.request(
      `/api/profiles/custom/${numericId}`,
      as(owner, { method: 'PUT', body: JSON.stringify({ system_prompt: 'Answer from the knowledge base, briefly.' }) }),
    );
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ is_shared: true, current_version: 2 });

    const versions = await app.request(`/api/profiles/custom/${numericId}/versions`, as(reader));
    expect(
      ((await versions.json()) as { versions: Array<{ version: number }> }).versions.map((v) => v.version),
    ).toEqual([2]);

    const lifecycle = await app.request(
      `/api/profiles/custom/${numericId}/lifecycle`,
      as(owner, { method: 'POST', body: JSON.stringify({ status: 'review' }) }),
    );
    expect(lifecycle.status).toBe(404);

    const deleted = await app.request(`/api/profiles/custom/${numericId}`, as(owner, { method: 'DELETE' }));
    expect(deleted.status).toBe(200);
    expect(await db.customProfiles.getById(Number(numericId))).toBeUndefined();
  });
});
