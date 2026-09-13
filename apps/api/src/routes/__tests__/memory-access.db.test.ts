/**
 * Memory access + lifecycle (real PostgreSQL).
 *
 * The first block is a regression test for why v1 never worked: all three gates
 * asked `user_features.isEnabled()`, which only reads the table. A super is
 * enabled by ROLE and has no row, and the flag is now default-on for everyone,
 * so a table lookup answers "false" for the entire team. Memory was dead for
 * its whole life and the settings page 403'd for the person who owned it.
 *
 * The rest pins the lifecycle the UI and the agent both depend on: recall wakes
 * a dormant memory, decay leaves pinned ones alone, and nothing the system
 * retires is silently destroyed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import authRoutes from '../auth.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;

function createApp(users: UserRow[]) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = byId.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/auth', authRoutes);
  return app;
}

async function seedMemory(userId: string, overrides: Partial<Parameters<typeof db.userMemories.create>[0]> = {}) {
  return db.userMemories.create({
    user_id: userId,
    category: 'fact',
    title: 'Works on the greenhouse monorepo',
    content: 'Primary repo is greenhouse; deploys go to the dev server.',
    ...overrides,
  });
}

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
});

describe('memory feature gating', () => {
  it('lets a super through with no user_features row at all', async () => {
    // The exact v1 failure: role-based entitlement, no row, table-only check.
    const superUser = await createInternalTestUser(db, { email: `super-${Date.now()}@test.local`, role: 'super' });
    expect(await db.userFeatures.isEnabled(superUser.id, 'memory')).toBe(false);

    const app = createApp([superUser]);
    const mem = await seedMemory(superUser.id);

    const list = await app.request('/api/auth/me/memories', { headers: { 'x-test-user': superUser.id } });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { memories: unknown[] }).memories).toHaveLength(1);

    const patch = await app.request(`/api/auth/me/memories/${mem.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': superUser.id },
      body: JSON.stringify({ pinned: true }),
    });
    expect(patch.status).toBe(200);

    const del = await app.request(`/api/auth/me/memories/${mem.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': superUser.id },
    });
    expect(del.status).toBe(200);
  });

  it('lets a team user through on the flag default, with no row', async () => {
    const teamUser = await createInternalTestUser(db, { email: `team-${Date.now()}@test.local` });
    await seedMemory(teamUser.id);

    const app = createApp([teamUser]);
    const res = await app.request('/api/auth/me/memories', { headers: { 'x-test-user': teamUser.id } });
    expect(res.status).toBe(200);
  });

  it('refuses a team user whose flag was explicitly turned off — on every verb', async () => {
    const teamUser = await createInternalTestUser(db, { email: `off-${Date.now()}@test.local` });
    await db.userFeatures.upsert({ user_id: teamUser.id, feature: 'memory', enabled: false });
    const mem = await seedMemory(teamUser.id);
    const app = createApp([teamUser]);

    const list = await app.request('/api/auth/me/memories', { headers: { 'x-test-user': teamUser.id } });
    expect(list.status).toBe(403);

    // v1 gated only the GET; PATCH and DELETE were reachable regardless.
    const patch = await app.request(`/api/auth/me/memories/${mem.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': teamUser.id },
      body: JSON.stringify({ content: 'edited' }),
    });
    expect(patch.status).toBe(403);

    const del = await app.request(`/api/auth/me/memories/${mem.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': teamUser.id },
    });
    expect(del.status).toBe(403);
  });
});

describe('memory ownership and validation', () => {
  it('404s on another user’s memory instead of leaking its existence', async () => {
    const owner = await createInternalTestUser(db, { email: `owner-${Date.now()}@test.local` });
    const other = await createInternalTestUser(db, { email: `other-${Date.now()}@test.local` });
    const mem = await seedMemory(owner.id);
    const app = createApp([owner, other]);

    const patch = await app.request(`/api/auth/me/memories/${mem.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': other.id },
      body: JSON.stringify({ content: 'hijacked' }),
    });
    expect(patch.status).toBe(404);

    const del = await app.request(`/api/auth/me/memories/${mem.id}`, {
      method: 'DELETE',
      headers: { 'x-test-user': other.id },
    });
    expect(del.status).toBe(404);

    expect((await db.userMemories.getById(mem.id))?.content).toBe(mem.content);
  });

  it('enforces ownership again at the mutation service boundary', async () => {
    const owner = await createInternalTestUser(db, { email: `service-owner-${Date.now()}@test.local` });
    const other = await createInternalTestUser(db, { email: `service-other-${Date.now()}@test.local` });
    const mem = await seedMemory(owner.id);

    await expect(db.userMemories.update(mem.id, other.id, { content: 'hijacked' })).resolves.toBeUndefined();
    await db.userMemories.touch([mem.id], other.id);
    await expect(db.userMemories.setStatus(mem.id, other.id, 'archived')).resolves.toBeUndefined();
    await expect(db.userMemories.delete(mem.id, other.id)).resolves.toBe(false);
    expect(await db.userMemories.getById(mem.id)).toMatchObject({
      content: mem.content,
      status: 'active',
      last_used_at: null,
    });
  });

  it('rejects an edit that would plant a secret in the prompt', async () => {
    const user = await createInternalTestUser(db, { email: `guard-${Date.now()}@test.local` });
    const mem = await seedMemory(user.id);
    const app = createApp([user]);

    const res = await app.request(`/api/auth/me/memories/${mem.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': user.id },
      body: JSON.stringify({ content: 'server password: hunter2' }),
    });
    expect(res.status).toBe(400);
    expect((await db.userMemories.getById(mem.id))?.content).toBe(mem.content);
  });

  it('refuses to set superseded by hand — that is a consolidation verdict', async () => {
    const user = await createInternalTestUser(db, { email: `status-${Date.now()}@test.local` });
    const mem = await seedMemory(user.id);
    const app = createApp([user]);

    const res = await app.request(`/api/auth/me/memories/${mem.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': user.id },
      body: JSON.stringify({ status: 'superseded' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('memory lifecycle', () => {
  it('wakes a dormant memory when it is actually recalled', async () => {
    const user = await createInternalTestUser(db, { email: `wake-${Date.now()}@test.local` });
    const mem = await seedMemory(user.id);
    await db.userMemories.setStatus(mem.id, user.id, 'dormant');

    await db.userMemories.touch([mem.id], user.id);

    const after = await db.userMemories.getById(mem.id);
    expect(after?.status).toBe('active');
    expect(after?.last_used_at).toBeTruthy();
  });

  it('leaves memories alone while they are inside the decay window', async () => {
    const user = await createInternalTestUser(db, { email: `fresh-${Date.now()}@test.local` });
    const fresh = await seedMemory(user.id, { title: 'Fresh note' });

    await db.userMemories.demoteStale(90);

    expect((await db.userMemories.getById(fresh.id))?.status).toBe('active');
  });

  it('drops stale memories out of the index but never pinned ones', async () => {
    const user = await createInternalTestUser(db, { email: `decay-${Date.now()}@test.local` });
    const stale = await seedMemory(user.id, { title: 'Stale note' });
    const pinned = await seedMemory(user.id, { title: 'Pinned note', pinned: true });

    // A zero-day window makes every existing row stale, so the boundary case
    // above and the pinned exemption here are both covered without having to
    // forge timestamps behind the service's back.
    const demoted = await db.userMemories.demoteStale(0);
    expect(demoted).toBeGreaterThanOrEqual(1);

    expect((await db.userMemories.getById(stale.id))?.status).toBe('dormant');
    expect((await db.userMemories.getById(pinned.id))?.status).toBe('active');

    // Dormant rows leave the prompt index but stay searchable.
    const index = await db.userMemories.listForIndex(user.id);
    expect(index.map((m) => m.id)).not.toContain(stale.id);
    const found = await db.userMemories.search(user.id, 'Stale', { includeInactive: true });
    expect(found.map((m) => m.id)).toContain(stale.id);
  });

  it('keeps superseded rows and the pointer to their replacement', async () => {
    const user = await createInternalTestUser(db, { email: `merge-${Date.now()}@test.local` });
    const oldMem = await seedMemory(user.id, { title: 'Old phrasing' });
    const merged = await seedMemory(user.id, { title: 'Merged phrasing', source: 'consolidation' });

    await db.userMemories.setStatus(oldMem.id, user.id, 'superseded', merged.id);

    const after = await db.userMemories.getById(oldMem.id);
    expect(after?.status).toBe('superseded');
    expect(after?.superseded_by).toBe(merged.id);
    expect(await db.userMemories.listForIndex(user.id)).toHaveLength(1);
  });
});
