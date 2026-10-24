/**
 * Session pins against a real PostgreSQL database.
 *
 * The owner's pin lives on `conversations`; a share recipient's pin lives on
 * their `conversation_share_reads` row, so pins stay private per user.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider } from '../index.js';
import { TEST_DATABASE_URL } from '../test-config.js';

let db: DatabaseProvider;

async function createUser(email: string) {
  return db.users.create({ email, password_hash: 'h', nickname: email, role: 'team' });
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

  it('keeps a recipient pin on their read row, independent of the owner and of read state', async () => {
    const owner = await createUser('owner@pins.test');
    const reader = await createUser('reader@pins.test');
    const shared = await db.sessions.create('shared', 'team', owner.id);
    await db.sessionShares.createMany([{ session_id: shared.id, shared_with: reader.id, shared_by: owner.id }]);

    await db.sessionPins.pin(reader.id, shared.id);
    expect(await db.sessionPins.getPinnedSessionIds(reader.id)).toEqual([shared.id]);
    expect(await db.sessionPins.getPinnedSessionIds(owner.id)).toEqual([]);
    expect((await db.sessions.getById(shared.id))?.pinned_at).toBeNull();

    // Pinning does not count as reading; reading later keeps the pin.
    expect(await db.sessionShares.countUnread(reader.id)).toBe(1);
    expect(await db.sessionShares.markAllReadInSession(reader.id, shared.id)).toBe(true);
    expect(await db.sessionShares.countUnread(reader.id)).toBe(0);
    expect(await db.sessionPins.getPinnedSessionIds(reader.id)).toEqual([shared.id]);

    await db.sessionPins.unpin(reader.id, shared.id);
    expect(await db.sessionPins.getPinnedSessionIds(reader.id)).toEqual([]);
    expect(await db.sessionShares.countUnread(reader.id)).toBe(0);
  });
});
