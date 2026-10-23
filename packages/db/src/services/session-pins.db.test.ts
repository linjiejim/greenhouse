/**
 * Session pins against a real PostgreSQL database.
 *
 * Pins live in `session_groups` as the per-user system group `kind='pinned'`.
 * Custom folders were removed in 1.5 but their rows remain, so the service must
 * keep reading only the Pinned group and never surface a filed-only session.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { _resetProvider, initDatabase, type DatabaseProvider } from '../index.js';
import { TEST_DATABASE_URL } from '../test-config.js';

let db: DatabaseProvider;

async function createUser(email: string) {
  return db.users.create({ email, password_hash: 'h', nickname: email, role: 'team' });
}

/** A pre-1.5 custom folder holding `sessionId`, written the way the old service did. */
async function legacyFolderWith(userId: string, sessionId: string) {
  const now = new Date().toISOString();
  const [group] = await db.executeRaw(
    sql`INSERT INTO session_groups (user_id, name, color, kind, sort_order, created_at, updated_at)
        VALUES (${userId}, 'Old folder', '#6B7280', 'custom', 0, ${now}, ${now}) RETURNING id`,
  );
  await db.executeRaw(
    sql`INSERT INTO session_group_members (user_id, group_id, session_id, kind, sort_order, created_at)
        VALUES (${userId}, ${group.id}, ${sessionId}, 'custom', 0, ${now})`,
  );
}

describe('session pins', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('pins in order, reorders, and unpins per user', async () => {
    const alice = await createUser('alice@pins.test');
    const bob = await createUser('bob@pins.test');
    const first = await db.sessions.create('first', 'team', alice.id);
    const second = await db.sessions.create('second', 'team', alice.id);

    await db.sessionPins.pin(alice.id, first.id);
    await db.sessionPins.pin(alice.id, second.id);
    await db.sessionPins.pin(alice.id, second.id); // idempotent

    expect((await db.sessionPins.getPinnedSessionIds(alice.id)).sort()).toEqual([first.id, second.id].sort());
    const sorts = await db.sessionPins.getPinSortsForUser(alice.id, [first.id, second.id]);
    expect(sorts.get(first.id)).toBeLessThan(sorts.get(second.id)!);

    await db.sessionPins.reorder(alice.id, [
      { session_id: second.id, sort_order: 0 },
      { session_id: first.id, sort_order: 1 },
    ]);
    const reordered = await db.sessionPins.getPinSortsForUser(alice.id, [first.id, second.id]);
    expect(reordered.get(second.id)).toBe(0);
    expect(reordered.get(first.id)).toBe(1);

    // Pins are private: another user sees none and cannot reorder them.
    expect(await db.sessionPins.getPinnedSessionIds(bob.id)).toEqual([]);
    await db.sessionPins.reorder(bob.id, [{ session_id: first.id, sort_order: 9 }]);
    expect((await db.sessionPins.getPinSortsForUser(alice.id, [first.id])).get(first.id)).toBe(1);

    await db.sessionPins.unpin(alice.id, first.id);
    expect(await db.sessionPins.getPinnedSessionIds(alice.id)).toEqual([second.id]);
  });

  it('ignores sessions that only sit in a legacy custom folder', async () => {
    const carol = await createUser('carol@pins.test');
    const filed = await db.sessions.create('filed', 'team', carol.id);
    const pinned = await db.sessions.create('pinned', 'team', carol.id);
    await legacyFolderWith(carol.id, filed.id);
    await db.sessionPins.pin(carol.id, pinned.id);

    expect(await db.sessionPins.getPinnedSessionIds(carol.id)).toEqual([pinned.id]);
    const sorts = await db.sessionPins.getPinSortsForUser(carol.id, [filed.id, pinned.id]);
    expect(sorts.has(filed.id)).toBe(false);
    expect(sorts.has(pinned.id)).toBe(true);

    // Unpinning never touches the folder row either.
    await db.sessionPins.unpin(carol.id, filed.id);
    const [{ count }] = await db.executeRaw(
      sql`SELECT count(*)::int AS count FROM session_group_members WHERE session_id = ${filed.id}`,
    );
    expect(count).toBe(1);
  });
});
