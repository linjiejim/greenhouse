/**
 * Session Share Repository integration tests.
 *
 * Tests session share CRUD, read tracking, and team-share logic
 * against a real PostgreSQL database.
 * Requires: PostgreSQL running at localhost:5432 with greenhouse_test database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';

const PG_URL = 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test';
let db: DatabaseProvider;

// ─── Helpers ─────────────────────────────────────────────

async function createUser(db: DatabaseProvider, email: string, nickname: string) {
  return db.users.create({ email, password_hash: 'h', nickname, role: 'member' });
}

async function createSession(db: DatabaseProvider, userId: string, title = 'Test Session') {
  return db.sessions.create(title, 'default', userId);
}

// ─── Tests ───────────────────────────────────────────────

describe('Session Share Repository', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: PG_URL });
    // resetSchema() TRUNCATEs all tables (incl. session_shares / session_share_reads)
    // with RESTART IDENTITY CASCADE — a clean slate for every test.
    await db.resetSchema();
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  // ─── createMany ────────────────────────────────────────

  it('creates shares for specific users', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
    ]);

    const shares = await db.sessionShares.getSharesForSession(session.id);
    expect(shares).toHaveLength(1);
    expect(shares[0].shared_with).toBe(bob.id);
    expect(shares[0].shared_by).toBe(alice.id);
    expect(shares[0].read_at).toBeNull();
    expect(shares[0].created_at).toBeTruthy();
  });

  it('creates team share with __team__ sentinel', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: '__team__', shared_by: alice.id, message: 'FYI' },
    ]);

    const shares = await db.sessionShares.getSharesForSession(session.id);
    expect(shares).toHaveLength(1);
    expect(shares[0].shared_with).toBe('__team__');
    expect(shares[0].message).toBe('FYI');
  });

  it('creates multiple shares at once', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const carol = await createUser(db, 'carol@test.com', 'Carol');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: session.id, shared_with: carol.id, shared_by: alice.id, message: 'Check this' },
      { session_id: session.id, shared_with: '__team__', shared_by: alice.id },
    ]);

    const shares = await db.sessionShares.getSharesForSession(session.id);
    expect(shares).toHaveLength(3);
  });

  it('no-ops when creating zero shares', async () => {
    await db.sessionShares.createMany([]);
    // Should not throw
  });

  // ─── countUnread ───────────────────────────────────────

  it('counts unread direct shares', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const s1 = await createSession(db, alice.id, 'Session 1');
    const s2 = await createSession(db, alice.id, 'Session 2');

    await db.sessionShares.createMany([
      { session_id: s1.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: s2.id, shared_with: bob.id, shared_by: alice.id },
    ]);

    expect(await db.sessionShares.countUnread(bob.id)).toBe(2);
  });

  it('counts team shares as unread for any user', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: '__team__', shared_by: alice.id },
    ]);

    // Bob should see team share as unread
    expect(await db.sessionShares.countUnread(bob.id)).toBe(1);
  });

  it('counts combined direct + team shares', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const s1 = await createSession(db, alice.id, 'S1');
    const s2 = await createSession(db, alice.id, 'S2');

    await db.sessionShares.createMany([
      { session_id: s1.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: s2.id, shared_with: '__team__', shared_by: alice.id },
    ]);

    expect(await db.sessionShares.countUnread(bob.id)).toBe(2);
  });

  it('returns zero for users with no shares', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    expect(await db.sessionShares.countUnread(alice.id)).toBe(0);
  });

  it('does not count read shares', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
    ]);

    const shares = await db.sessionShares.listForUser(bob.id);
    await db.sessionShares.markReadForUser(shares[0].id, bob.id);

    expect(await db.sessionShares.countUnread(bob.id)).toBe(0);
  });

  // ─── listForUser ───────────────────────────────────────

  it('lists direct shares for a user', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
    ]);

    const list = await db.sessionShares.listForUser(bob.id);
    expect(list).toHaveLength(1);
    expect(list[0].session_id).toBe(session.id);
  });

  it('includes team shares in user listing', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: '__team__', shared_by: alice.id },
    ]);

    const list = await db.sessionShares.listForUser(bob.id);
    expect(list).toHaveLength(1);
  });

  it('orders unread first, then by created_at desc', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const s1 = await createSession(db, alice.id, 'First');
    const s2 = await createSession(db, alice.id, 'Second');

    await db.sessionShares.createMany([
      { session_id: s1.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: s2.id, shared_with: bob.id, shared_by: alice.id },
    ]);

    // Mark first as read
    const list = await db.sessionShares.listForUser(bob.id);
    const firstShare = list.find((s) => s.session_id === s1.id)!;
    await db.sessionShares.markReadForUser(firstShare.id, bob.id);

    const sorted = await db.sessionShares.listForUser(bob.id);
    // Unread share should come first
    expect(sorted[0].user_read_at).toBeNull();
    expect(sorted[0].session_id).toBe(s2.id);
    // Read share comes second
    expect(sorted[1].user_read_at).not.toBeNull();
    expect(sorted[1].session_id).toBe(s1.id);
  });

  it('respects limit and offset', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');

    for (let i = 0; i < 5; i++) {
      const s = await createSession(db, alice.id, `S${i}`);
      await db.sessionShares.createMany([
        { session_id: s.id, shared_with: bob.id, shared_by: alice.id },
      ]);
    }

    const page1 = await db.sessionShares.listForUser(bob.id, { limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);

    const page2 = await db.sessionShares.listForUser(bob.id, { limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);

    const page3 = await db.sessionShares.listForUser(bob.id, { limit: 2, offset: 4 });
    expect(page3).toHaveLength(1);
  });

  it('does not list shares intended for other users', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const carol = await createUser(db, 'carol@test.com', 'Carol');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: carol.id, shared_by: alice.id },
    ]);

    const bobList = await db.sessionShares.listForUser(bob.id);
    expect(bobList).toHaveLength(0);
  });

  // ─── markReadForUser / markAllReadInSession ────────────

  it('marks a single share as read for a user', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
    ]);

    const shares = await db.sessionShares.listForUser(bob.id);
    expect(shares[0].user_read_at).toBeNull();

    await db.sessionShares.markReadForUser(shares[0].id, bob.id);

    const updated = await db.sessionShares.listForUser(bob.id);
    expect(updated[0].user_read_at).not.toBeNull();
  });

  it('marks all shares in a session as read for a user', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const s1 = await createSession(db, alice.id, 'S1');
    const s2 = await createSession(db, alice.id, 'S2');

    await db.sessionShares.createMany([
      { session_id: s1.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: s1.id, shared_with: '__team__', shared_by: alice.id },
      { session_id: s2.id, shared_with: bob.id, shared_by: alice.id },
    ]);

    expect(await db.sessionShares.countUnread(bob.id)).toBe(3);

    await db.sessionShares.markAllReadInSession(bob.id, s1.id);

    // Only s1 shares should be read; s2 share still unread
    expect(await db.sessionShares.countUnread(bob.id)).toBe(1);
  });

  it('markAllReadInSession does not affect other users', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const carol = await createUser(db, 'carol@test.com', 'Carol');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: session.id, shared_with: carol.id, shared_by: alice.id },
    ]);

    await db.sessionShares.markAllReadInSession(bob.id, session.id);

    // Carol's share should still be unread
    expect(await db.sessionShares.countUnread(carol.id)).toBe(1);
    // Bob's share should be read
    expect(await db.sessionShares.countUnread(bob.id)).toBe(0);
  });

  it('markAllRead marks every unread share for a user as read', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const s1 = await createSession(db, alice.id, 'S1');
    const s2 = await createSession(db, alice.id, 'S2');

    await db.sessionShares.createMany([
      { session_id: s1.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: s1.id, shared_with: '__team__', shared_by: alice.id },
      { session_id: s2.id, shared_with: bob.id, shared_by: alice.id },
    ]);

    expect(await db.sessionShares.countUnread(bob.id)).toBe(3);

    await db.sessionShares.markAllRead(bob.id);

    expect(await db.sessionShares.countUnread(bob.id)).toBe(0);
    const listed = await db.sessionShares.listForUser(bob.id);
    expect(listed.every((s) => s.user_read_at !== null)).toBe(true);
  });

  it('markAllRead does not affect other users', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const carol = await createUser(db, 'carol@test.com', 'Carol');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: session.id, shared_with: carol.id, shared_by: alice.id },
    ]);

    await db.sessionShares.markAllRead(bob.id);

    expect(await db.sessionShares.countUnread(bob.id)).toBe(0);
    expect(await db.sessionShares.countUnread(carol.id)).toBe(1);
  });

  it('markAllRead is a no-op when there is nothing to read', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    await expect(db.sessionShares.markAllRead(alice.id)).resolves.toBeUndefined();
    expect(await db.sessionShares.countUnread(alice.id)).toBe(0);
  });

  // ─── getSharedSessionIds ───────────────────────────────

  it('returns distinct session IDs shared with a user', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const s1 = await createSession(db, alice.id, 'S1');
    const s2 = await createSession(db, alice.id, 'S2');
    const s3 = await createSession(db, alice.id, 'S3');

    await db.sessionShares.createMany([
      { session_id: s1.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: s2.id, shared_with: '__team__', shared_by: alice.id },
    ]);

    const ids = await db.sessionShares.getSharedSessionIds(bob.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s2.id);
    expect(ids).not.toContain(s3.id);
  });

  it('deduplicates when user has both direct and team share for same session', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: session.id, shared_with: '__team__', shared_by: alice.id },
    ]);

    const ids = await db.sessionShares.getSharedSessionIds(bob.id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(session.id);
  });

  it('returns empty array for users with no shares', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const ids = await db.sessionShares.getSharedSessionIds(alice.id);
    expect(ids).toEqual([]);
  });

  // ─── getSharesForSession ───────────────────────────────

  it('returns all shares for a session', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const carol = await createUser(db, 'carol@test.com', 'Carol');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: session.id, shared_with: carol.id, shared_by: alice.id },
      { session_id: session.id, shared_with: '__team__', shared_by: alice.id },
    ]);

    const shares = await db.sessionShares.getSharesForSession(session.id);
    expect(shares).toHaveLength(3);
  });

  it('returns empty array for session with no shares', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const session = await createSession(db, alice.id);
    const shares = await db.sessionShares.getSharesForSession(session.id);
    expect(shares).toEqual([]);
  });

  // ─── deleteForSession ──────────────────────────────────

  it('deletes all shares for a session', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: session.id, shared_with: '__team__', shared_by: alice.id },
    ]);

    expect(await db.sessionShares.getSharesForSession(session.id)).toHaveLength(2);

    await db.sessionShares.deleteForSession(session.id);

    expect(await db.sessionShares.getSharesForSession(session.id)).toHaveLength(0);
    expect(await db.sessionShares.countUnread(bob.id)).toBe(0);
  });

  it('deleteForSession does not affect other sessions', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const s1 = await createSession(db, alice.id, 'S1');
    const s2 = await createSession(db, alice.id, 'S2');

    await db.sessionShares.createMany([
      { session_id: s1.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: s2.id, shared_with: bob.id, shared_by: alice.id },
    ]);

    await db.sessionShares.deleteForSession(s1.id);

    expect(await db.sessionShares.getSharesForSession(s1.id)).toHaveLength(0);
    expect(await db.sessionShares.getSharesForSession(s2.id)).toHaveLength(1);
    expect(await db.sessionShares.countUnread(bob.id)).toBe(1);
  });

  // ─── Edge cases ────────────────────────────────────────

  it('preserves message field correctly', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id, message: 'Please review' },
    ]);

    const shares = await db.sessionShares.getSharesForSession(session.id);
    expect(shares[0].message).toBe('Please review');
  });

  it('stores null message when not provided', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
    ]);

    const shares = await db.sessionShares.getSharesForSession(session.id);
    expect(shares[0].message).toBeNull();
  });

  // ─── Deduplication ───────────────────────────────

  it('silently ignores duplicate shares', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
    ]);
    // Share again — should not throw or create duplicate
    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
    ]);

    const shares = await db.sessionShares.getSharesForSession(session.id);
    expect(shares).toHaveLength(1);
  });

  // ─── deleteOne ───────────────────────────────────

  it('deletes a single share by id', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const carol = await createUser(db, 'carol@test.com', 'Carol');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: bob.id, shared_by: alice.id },
      { session_id: session.id, shared_with: carol.id, shared_by: alice.id },
    ]);

    const shares = await db.sessionShares.getSharesForSession(session.id);
    expect(shares).toHaveLength(2);

    const bobShare = shares.find((s) => s.shared_with === bob.id)!;
    await db.sessionShares.deleteOne(bobShare.id);

    const remaining = await db.sessionShares.getSharesForSession(session.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].shared_with).toBe(carol.id);
  });

  // ─── Team share read isolation ────────────────────

  it('team share read status is per-user (not global)', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const bob = await createUser(db, 'bob@test.com', 'Bob');
    const carol = await createUser(db, 'carol@test.com', 'Carol');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: '__team__', shared_by: alice.id },
    ]);

    // Bob reads it
    await db.sessionShares.markAllReadInSession(bob.id, session.id);

    // Bob should see 0 unread, Carol should still see 1
    expect(await db.sessionShares.countUnread(bob.id)).toBe(0);
    expect(await db.sessionShares.countUnread(carol.id)).toBe(1);
  });

  it('self-shared team share is excluded from listing', async () => {
    const alice = await createUser(db, 'alice@test.com', 'Alice');
    const session = await createSession(db, alice.id);

    await db.sessionShares.createMany([
      { session_id: session.id, shared_with: '__team__', shared_by: alice.id },
    ]);

    // Alice should NOT see her own team share in listing
    const list = await db.sessionShares.listForUser(alice.id);
    expect(list).toHaveLength(0);
  });
});
