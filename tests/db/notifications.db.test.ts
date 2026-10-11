/** Permanent platform notification and delivery-ledger integration tests. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let other: UserRow;

function unique(label: string): string {
  return `${label}:${Date.now()}:${Math.random()}`;
}

describe('platform notification service', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `${unique('notification-owner')}@test.local` });
    other = await createInternalTestUser(db, { email: `${unique('notification-other')}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('keeps exact payloads permanently and makes projection retries idempotent', async () => {
    const exact = '完整参数'.repeat(12_000);
    const input = {
      user_id: owner.id,
      kind: 'runtime_attention' as const,
      title: 'Mission needs approval',
      body: 'Review the exact mutation before it executes.',
      payload: { mutation: { exact, nested: [true, null, 42] } },
      run_id: unique('run'),
      interrupt_id: unique('interrupt'),
      event_id: unique('event'),
      dedupe_key: unique('dedupe'),
    };
    const first = await db.notifications.createWithStatus(input);
    const replay = await db.notifications.createWithStatus(input);

    expect(first.created).toBe(true);
    expect(replay).toEqual({ notification: first.notification, created: false });
    expect(await db.notifications.get(first.notification.id)).toEqual(first.notification);
    expect(JSON.parse(first.notification.payload)).toEqual(input.payload);
    expect(await db.notifications.countUnread(owner.id)).toBe(1);
    await expect(db.notifications.create({ ...input, body: 'A conflicting retry' })).rejects.toMatchObject({
      code: 'notification_idempotency_conflict',
    });
  });

  it('enforces recipient ownership, stable cursor pagination, and idempotent read state', async () => {
    const older = await db.notifications.create({
      user_id: owner.id,
      kind: 'system',
      title: 'Older',
      body: 'Older notification',
      dedupe_key: unique('older'),
      created_at: '2026-08-12T01:00:00.000Z',
    });
    const newer = await db.notifications.create({
      user_id: owner.id,
      kind: 'runtime_completed',
      title: 'Newer',
      body: 'Newer notification',
      dedupe_key: unique('newer'),
      created_at: '2026-08-12T02:00:00.000Z',
    });

    const firstPage = await db.notifications.listForUser({ user_id: owner.id, limit: 1 });
    expect(firstPage.items.map((row) => row.id)).toEqual([newer.id]);
    expect(firstPage.next_cursor).toEqual({ created_at: newer.created_at, id: newer.id });
    const secondPage = await db.notifications.listForUser({
      user_id: owner.id,
      limit: 1,
      cursor: firstPage.next_cursor,
    });
    expect(secondPage.items.map((row) => row.id)).toEqual([older.id]);

    expect(await db.notifications.markRead(newer.id, other.id)).toBeUndefined();
    const read = await db.notifications.markRead(newer.id, owner.id, '2026-08-12T03:00:00.000Z');
    expect(Date.parse(read!.read_at!)).toBe(Date.parse('2026-08-12T03:00:00.000Z'));
    expect(await db.notifications.markRead(newer.id, owner.id, '2026-08-12T04:00:00.000Z')).toEqual(read);
    expect(await db.notifications.countUnread(owner.id)).toBe(1);
    expect(await db.notifications.markAllRead(owner.id)).toBe(1);
    expect(await db.notifications.countUnread(owner.id)).toBe(0);
  });

  it('leases optional delivery attempts and retries failures without changing the notification fact', async () => {
    const notification = await db.notifications.create({
      user_id: owner.id,
      kind: 'runtime_failed',
      title: 'Mission needs review',
      body: 'The business run remains failed independently of delivery.',
      dedupe_key: unique('delivery-notification'),
    });
    const attempt = await db.notifications.createDelivery({
      notification_id: notification.id,
      channel: 'desktop',
      recipient: owner.id,
      max_attempts: 2,
    });
    expect(
      (
        await db.notifications.createDelivery({
          notification_id: notification.id,
          channel: 'desktop',
          recipient: owner.id,
          max_attempts: 2,
        })
      ).id,
    ).toBe(attempt.id);

    const claimed = await db.notifications.claimDeliveries({ worker_id: 'notification-worker', lease_ms: 60_000 });
    expect(claimed).toHaveLength(1);
    const failed = await db.notifications.failDelivery({
      id: claimed[0]!.id,
      expected_version: claimed[0]!.version,
      worker_id: 'notification-worker',
      error: 'desktop offline',
      retry_at: new Date(Date.now() - 1_000),
    });
    expect(failed.status).toBe('pending');
    const retried = await db.notifications.claimDeliveries({ worker_id: 'notification-worker', lease_ms: 60_000 });
    expect(retried[0]).toMatchObject({ id: attempt.id, attempts: 2, status: 'claimed' });
    const delivered = await db.notifications.acknowledgeDelivery({
      id: retried[0]!.id,
      expected_version: retried[0]!.version,
      worker_id: 'notification-worker',
    });
    expect(delivered.status).toBe('delivered');
    expect(await db.notifications.getForUser(notification.id, owner.id)).toEqual(notification);
  });

  it("marks a conversation's reply alerts read by dedupe prefix — literally, for that member only", async () => {
    const make = (user: UserRow, dedupe: string) =>
      db.notifications.create({
        user_id: user.id,
        kind: 'bots_reply',
        title: 'Sprouty',
        body: 'Open it.',
        dedupe_key: dedupe,
      });
    const session = unique('bots_s1');
    const mine = await make(owner, `bots-reply:${session}:m1`);
    const mineToo = await make(owner, `bots-reply:${session}:m2`);
    // `_` would match any character in a raw LIKE pattern: this sibling session must stay unread
    const lookalike = await make(owner, `bots-reply:${session.replace('_', 'x')}:m1`);
    const theirs = await make(other, `bots-reply:${session}:m1`);

    expect(await db.notifications.getByDedupeKey(owner.id, `bots-reply:${session}:m2`)).toEqual(mineToo);
    expect(await db.notifications.getByDedupeKey(other.id, `bots-reply:${session}:m2`)).toBeUndefined();

    expect(await db.notifications.markReadByDedupePrefix(owner.id, `bots-reply:${session}:`)).toBe(2);
    expect((await db.notifications.getForUser(mine.id, owner.id))?.read_at).not.toBeNull();
    expect((await db.notifications.getForUser(mineToo.id, owner.id))?.read_at).not.toBeNull();
    expect((await db.notifications.getForUser(lookalike.id, owner.id))?.read_at).toBeNull();
    expect((await db.notifications.getForUser(theirs.id, other.id))?.read_at).toBeNull();
    // already read: nothing changes
    expect(await db.notifications.markReadByDedupePrefix(owner.id, `bots-reply:${session}:`)).toBe(0);
  });

  it('settles a leased attempt for good (suppressed / failed) and never hands it out again', async () => {
    const notification = await db.notifications.create({
      user_id: owner.id,
      kind: 'system',
      title: 'Sprouty asks to edit the knowledge base',
      body: 'Open Bots to review it.',
      dedupe_key: unique('push-settle'),
    });
    await db.notifications.createDelivery({
      notification_id: notification.id,
      channel: 'mobile_push',
      recipient: 'pdv_a',
    });
    await db.notifications.createDelivery({
      notification_id: notification.id,
      channel: 'mobile_push',
      recipient: 'pdv_b',
    });
    const claimed = await db.notifications.claimDeliveries({
      worker_id: 'push-worker',
      lease_ms: 60_000,
      channels: ['mobile_push'],
    });
    const mine = claimed.filter((row) => row.notification_id === notification.id);
    expect(mine).toHaveLength(2);

    const suppressed = await db.notifications.settleDelivery({
      id: mine[0]!.id,
      expected_version: mine[0]!.version,
      worker_id: 'push-worker',
      status: 'suppressed',
      reason: 'request_settled',
    });
    expect(suppressed).toMatchObject({ status: 'suppressed', last_error: 'request_settled', lease_owner: null });
    const failed = await db.notifications.settleDelivery({
      id: mine[1]!.id,
      expected_version: mine[1]!.version,
      worker_id: 'push-worker',
      status: 'failed',
      reason: 'DeviceNotRegistered',
    });
    expect(failed.status).toBe('failed');
    // a stale lease cannot settle twice
    await expect(
      db.notifications.settleDelivery({
        id: mine[0]!.id,
        expected_version: mine[0]!.version,
        worker_id: 'push-worker',
        status: 'suppressed',
        reason: 'again',
      }),
    ).rejects.toMatchObject({ code: 'notification_lease_lost' });
    const again = await db.notifications.claimDeliveries({
      worker_id: 'push-worker',
      lease_ms: 60_000,
      channels: ['mobile_push'],
    });
    expect(again.filter((row) => row.notification_id === notification.id)).toEqual([]);
  });
});
