/**
 * `sessions.addUserTurn` admits one copy of a client turn even when two API
 * instances (no shared in-memory run claim) write it at the same moment.
 *
 * @db-commit-reason The race needs two connection pools writing committed rows
 * concurrently; one rollback transaction would serialize them on one connection.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let a: DatabaseProvider;
let b: DatabaseProvider;
let userId: string;

describe('client turn dedup across instances', () => {
  beforeAll(async () => {
    a = createDatabase(TEST_DATABASE_URL);
    b = createDatabase(TEST_DATABASE_URL);
    const user = await a.users.create({
      email: `client-turn-${randomUUID()}@test.com`,
      password_hash: 'hash',
      nickname: 'Client Turn',
      role: 'team',
    });
    userId = user.id;
  });

  afterAll(async () => {
    await a.users.delete(userId);
    await a.close();
    await b.close();
  });

  it('saves exactly one message for concurrent writes of one turn', async () => {
    const session = await a.sessions.create('t', 'sprouty', userId);
    try {
      const turn = { session_id: session.id, role: 'user' as const, content: 'x', client_turn_id: 'turn_race-0001' };
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).sessions.addUserTurn(turn)),
      );
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      const id = (winners[0] as { ok: true; message: { id: string } }).message.id;
      for (const r of results.filter((r) => !r.ok)) expect(r).toMatchObject({ duplicate: { id } });
      expect(await a.sessions.getMessages(session.id)).toHaveLength(1);
      // The unique index backs the session lock: a raw duplicate insert is rejected.
      await expect(a.sessions.addMessage(turn)).rejects.toThrow();
    } finally {
      await a.sessions.delete(session.id);
    }
  });
});
