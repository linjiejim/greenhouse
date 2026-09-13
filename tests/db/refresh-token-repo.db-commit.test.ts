/**
 * Refresh-token repository integration tests.
 *
 * @db-commit-reason The concurrent-consume case needs two independent
 * connections observing committed state, so per-test transaction rollback
 * would invalidate the behavior under test.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;
const runId = randomUUID();
const createdUserIds: string[] = [];

describe('Refresh Token Repository', () => {
  beforeAll(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterAll(async () => {
    for (const userId of createdUserIds) {
      await db.users.delete(userId);
    }
    await db.close();
    _resetProvider();
  });

  it('allows exactly one concurrent consumer for a refresh token', async () => {
    const user = await db.users.create({
      email: `refresh-race-${runId}@test.com`,
      password_hash: 'hash',
      nickname: 'Refresh Race',
      role: 'team',
    });
    createdUserIds.push(user.id);
    const tokenHash = `concurrent-refresh-token-hash-${runId}`;
    await db.refreshTokens.create(user.id, tokenHash, new Date(Date.now() + 60_000).toISOString(), user.auth_version);

    const results = await Promise.all([db.refreshTokens.consume(tokenHash), db.refreshTokens.consume(tokenHash)]);

    expect(results.filter((row) => row !== null)).toHaveLength(1);
    expect(results.find((row) => row !== null)?.auth_version).toBe(0);
    expect(results.filter((row) => row === null)).toHaveLength(1);
  });

  it('does not consume an expired refresh token', async () => {
    const user = await db.users.create({
      email: `expired-refresh-${runId}@test.com`,
      password_hash: 'hash',
      nickname: 'Expired Refresh',
      role: 'team',
    });
    createdUserIds.push(user.id);
    const tokenHash = `expired-refresh-token-hash-${runId}`;
    await db.refreshTokens.create(user.id, tokenHash, new Date(Date.now() - 60_000).toISOString(), user.auth_version);

    await expect(db.refreshTokens.consume(tokenHash)).resolves.toBeNull();
  });

  it('atomically bumps auth version and revokes refresh tokens on password reset', async () => {
    const user = await db.users.create({
      email: `password-reset-${runId}@test.com`,
      password_hash: 'old-hash',
      nickname: 'Password Reset',
      role: 'team',
    });
    createdUserIds.push(user.id);
    const tokenHash = `pre-reset-refresh-token-hash-${runId}`;
    await db.refreshTokens.create(user.id, tokenHash, new Date(Date.now() + 60_000).toISOString(), user.auth_version);

    const updated = await db.users.resetPasswordAndRevokeSessions(user.id, 'new-hash');

    expect(updated).toMatchObject({ password_hash: 'new-hash', auth_version: 1 });
    await expect(db.refreshTokens.consume(tokenHash)).resolves.toBeNull();
  });
});
