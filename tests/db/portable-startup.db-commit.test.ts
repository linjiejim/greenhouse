/** @db-commit-reason Startup migrations and concurrent first-admin creation use
 * separate connections and committed schema/account state in owned databases. */
import { afterEach, expect, it, vi } from 'vitest';
import { applyAllMigrations, createDatabase, detectDatabaseGenerationAt } from '@greenhouse/db';
import {
  TEST_DATABASE_URL,
  buildV3Database,
  dropDatabase,
  queryRows,
  recreateDatabase,
} from '@greenhouse/db/test-config';
import { extensionMigrationSources } from '../../apps/api/src/plugin-host/boot.js';
import { bootstrapPlatform } from '../../apps/api/src/plugin-host/bootstrap.js';
import { bootstrapFirstAdmin } from '../../apps/api/src/security/first-admin.js';
import { logger } from '@greenhouse/utils/logger';

async function withDatabase(run: (url: string) => Promise<void>) {
  const name = `test_portable_startup_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const url = await recreateDatabase(TEST_DATABASE_URL, name);
  try {
    await run(url);
  } finally {
    await dropDatabase(TEST_DATABASE_URL, name);
  }
}
afterEach(() => vi.restoreAllMocks());

it('migrates an empty database including the active plugin lanes, concurrently and idempotently', async () => {
  await withDatabase(async (url) => {
    const opts = { extensionSources: extensionMigrationSources(), allowV3Bridge: false };
    const results = await Promise.all([applyAllMigrations(url, opts), applyAllMigrations(url, opts)]);
    expect(results.map((result) => result.generation.kind).sort()).toEqual(['empty', 'v4']);
    const before = await queryRows(url, 'SELECT * FROM drizzle.__drizzle_migrations ORDER BY id');
    const again = await applyAllMigrations(url, opts);
    expect(again.extensions?.applied).toEqual([]);
    expect(await queryRows(url, 'SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).toEqual(before);
    const db = createDatabase(url);
    try {
      await expect(db.initSchema()).resolves.toBeUndefined();
    } finally {
      await db.close();
    }
  });
}, 60_000);

it('refuses a 3.x database before any mutation, while manual migration can still bridge it', async () => {
  await withDatabase(async (url) => {
    await buildV3Database(url);
    const before = await queryRows(url, 'SELECT * FROM drizzle.__drizzle_migrations ORDER BY id');
    await expect(applyAllMigrations(url, { allowV3Bridge: false })).rejects.toThrow(
      /MIGRATE_ON_START.*3\.x.*Back up.*pnpm db:migrate/,
    );
    expect((await detectDatabaseGenerationAt(url)).kind).toBe('v3');
    expect(await queryRows(url, 'SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).toEqual(before);
    expect((await applyAllMigrations(url)).bridged).not.toBeNull();
  });
}, 60_000);

it.each(['v1', 'v2'] as const)(
  'retains the existing %s refusal on automatic migration',
  async (generation) => {
    await withDatabase(async (url) => {
      await queryRows(
        url,
        generation === 'v1'
          ? 'CREATE TABLE users(id text); CREATE TABLE sessions(id text)'
          : 'CREATE TABLE members(id text)',
      );
      await expect(applyAllMigrations(url, { allowV3Bridge: false })).rejects.toMatchObject({
        generation: { kind: generation },
      });
      expect((await detectDatabaseGenerationAt(url)).kind).toBe(generation);
    });
  },
  30_000,
);

it('two boots racing to create the same email both issue through the invite service and leave only the newest link valid', async () => {
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  await withDatabase(async (url) => {
    await applyAllMigrations(url);
    const db1 = createDatabase(url);
    const db2 = createDatabase(url);
    try {
      await bootstrapPlatform(db1);
      // Force both connections past their absent-email read before either insert.
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      for (const db of [db1, db2]) {
        const read = db.users.getByEmail;
        vi.spyOn(db.users, 'getByEmail').mockImplementationOnce(async (address) => {
          const user = await read(address);
          if (++arrived === 2) release();
          await barrier;
          return user;
        });
      }
      const env = { BOOTSTRAP_ADMIN_EMAIL: `race-${crypto.randomUUID()}@test.local` };
      const results = await Promise.all([bootstrapFirstAdmin(db1, env), bootstrapFirstAdmin(db2, env)]);
      expect(results.every((result) => result.status === 'issued')).toBe(true);
      const tokens = results.map((result) =>
        result.status === 'issued' ? new URLSearchParams(result.link.split('#')[1]).get('token')! : '',
      );
      const inspected = await Promise.all(tokens.map((token) => db1.accountPasswordLinks.inspect(token)));
      expect(inspected.filter(Boolean)).toHaveLength(1);
      const user = (await db1.users.getByEmail(env.BOOTSTRAP_ADMIN_EMAIL))!;
      expect((await db1.platform.listRoleBindings()).filter((binding) => binding.user_id === user.id)).toHaveLength(1);
      const valid = tokens[inspected.findIndex(Boolean)];
      await db1.accountPasswordLinks.complete(valid, 'activated-password-hash');
      const linksBefore = await queryRows(url, 'SELECT * FROM password_links ORDER BY id');
      expect(await bootstrapFirstAdmin(db2, env)).toEqual({ status: 'established' });
      expect(await queryRows(url, 'SELECT * FROM password_links ORDER BY id')).toEqual(linksBefore);
    } finally {
      await db1.close();
      await db2.close();
    }
  });
}, 60_000);
