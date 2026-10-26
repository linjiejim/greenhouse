/** @db-commit-reason Subscribers and another API replica must see only committed lifecycle writes. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { initDatabase, createDatabase, _resetProvider, type DatabaseProvider } from '@greenhouse/db';
import { isolatedDatabase } from '../../../../../tests/helpers/isolated-db.js';
let fixture: Awaited<ReturnType<typeof isolatedDatabase>>;
import { bootstrapPlatform } from '../../platform/bootstrap.js';
import adminRoutes from '../../routes/admin.js';
import type { AppEnv } from '../../app-env.js';
import { registerExtensionHooks } from '../events.js';
let db: DatabaseProvider, other: DatabaseProvider;
const installId = `sdk2-install-${crypto.randomUUID()}`;
beforeAll(async () => {
  fixture = await isolatedDatabase('lifecycle');
  db = await initDatabase({ type: 'pg', pgConnectionString: fixture.url });
  other = createDatabase(fixture.url);
  await bootstrapPlatform(db);
}, 30_000);
afterAll(async () => {
  await other.close();
  await db.close();
  _resetProvider();
  await fixture?.drop();
}, 30_000);
it('runs onInstall once under concurrent replica boots and persists the marker for a new runner', async () => {
  const effects: string[] = [];
  const install = async () => {
    effects.push('installed');
  };
  expect(
    (
      await Promise.all([
        db.extensionMigrations.installOnce(installId, install),
        other.extensionMigrations.installOnce(installId, install),
      ])
    ).sort(),
  ).toEqual([false, true]);
  expect(effects).toEqual(['installed']);
  expect(await other.extensionMigrations.installOnce(installId, install)).toBe(false);
});
it('delivers user lifecycle observations only after writes are visible through another connection', async () => {
  const admin = await db.users.create({
    email: `sdk2-admin-${crypto.randomUUID()}@test.local`,
    password_hash: 'hash',
    nickname: 'Admin',
    role: 'super',
  });
  const observations: Array<{ id: string; status: string | undefined }> = [];
  registerExtensionHooks('commit-observer', (hooks) => {
    hooks.on('user.created', async ({ userId }) => {
      observations.push({ id: userId, status: (await other.users.getById(userId))?.status });
    });
    hooks.on('user.disabled', async ({ userId }) => {
      observations.push({ id: userId, status: (await other.users.getById(userId))?.status });
    });
  });
  const app = new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: admin.id, role: 'super' });
      await next();
    })
    .route('/api/admin', adminRoutes);
  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await app.request(
    '/api/admin/users',
    json('POST', {
      email: `sdk2-member-${crypto.randomUUID()}@test.local`,
      nickname: 'Member',
      password: 'Test-password-123',
      credential_mode: 'direct_password',
      role: 'team',
    }),
  );
  expect(response.status).toBe(201);
  const created = (await response.json()).user;
  await vi.waitFor(() => expect(observations).toContainEqual({ id: created.id, status: 'active' }));
  expect((await app.request(`/api/admin/users/${created.id}`, json('PATCH', { status: 'disabled' }))).status).toBe(200);
  await vi.waitFor(() => expect(observations).toContainEqual({ id: created.id, status: 'disabled' }));
});
