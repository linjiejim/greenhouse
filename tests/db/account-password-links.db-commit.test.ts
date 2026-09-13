/**
 * Account password link concurrency integration test.
 *
 * @db-commit-reason Two independent connections must contend on the same user
 * row to prove a one-time link has exactly one successful concurrent consumer.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, UNSET_ACCOUNT_PASSWORD_HASH } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;
const createdUserIds: string[] = [];

describe('account password link concurrent consumption', () => {
  beforeAll(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterAll(async () => {
    for (const userId of createdUserIds) await db.users.delete(userId);
    await db.close();
    _resetProvider();
  });

  it('allows exactly one concurrent password submission', async () => {
    const user = await db.users.create({
      email: `password-link-race-${randomUUID()}@test.local`,
      password_hash: UNSET_ACCOUNT_PASSWORD_HASH,
      nickname: 'Password Link Race',
      role: 'team',
      status: 'invited',
    });
    createdUserIds.push(user.id);
    const issued = await db.accountPasswordLinks.issueInvite(user.id, 'admin-user');

    const results = await Promise.all([
      db.accountPasswordLinks.complete(issued!.token, 'hash-a'),
      db.accountPasswordLinks.complete(issued!.token, 'hash-b'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    const stored = await db.users.getById(user.id);
    expect(stored).toMatchObject({ status: 'active', auth_version: 1 });
    expect(['hash-a', 'hash-b']).toContain(stored?.password_hash);
  });
});
