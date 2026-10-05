/**
 * The computer locks two blue/green API slots rely on, against real
 * PostgreSQL: two clients stand in for the two processes.
 *
 * @db-commit-reason advisory locks only exclude each other across independent
 * connections (a rollback-wrapped single connection re-enters its own locks),
 * and the DevTools-owner lock must be freed by the database when the owning
 * process's connection dies — which only a real second connection can show.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { createDbClient, type DbClient } from '../client.js';
import { assertSafeTestDatabase, TEST_DATABASE_URL } from '../test-config.js';
import { createBotComputerService, type BotComputerService } from './bot-computers.js';

interface Slot {
  client: DbClient;
  computers: BotComputerService;
}

function slot(): Slot {
  const client = createDbClient(TEST_DATABASE_URL);
  return { client, computers: createBotComputerService(client.db) };
}

/** Session-level advisory locks currently held in the database for the DevTools-owner key of `userId`. */
async function cdpLocksHeld(observer: Slot, userId: string): Promise<number> {
  const [row] = await observer.client.db.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM pg_locks
    WHERE locktype = 'advisory' AND granted
      AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${`greenhouse-bot-computer-cdp:${userId}`}, 0)`);
  return Number(row?.n ?? 0);
}

describe('bot computer locks across processes', () => {
  let a: Slot;
  let b: Slot;
  let observer: Slot;

  beforeAll(() => {
    assertSafeTestDatabase(TEST_DATABASE_URL);
    a = slot();
    b = slot();
    observer = slot();
  });

  afterAll(async () => {
    await Promise.all([a, b, observer].map((s) => s.client.client.end({ timeout: 5 })));
  });

  it('tryWithUserLock skips a member whose lock another transaction holds, and takes it once free', async () => {
    const userId = `u-${randomUUID()}`;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    // Slot A is at work on the member (a start under the blocking lock).
    const working = a.computers.withUserLock(userId, async () => {
      entered();
      await held;
      return 'started';
    });
    await inside;

    let ran = false;
    const skipped = await b.computers.tryWithUserLock(userId, async () => {
      ran = true;
      return 'swept';
    });
    expect(skipped).toEqual({ acquired: false });
    expect(ran).toBe(false);

    // Another member is not affected.
    expect(await b.computers.tryWithUserLock(`u-${randomUUID()}`, async () => 'other')).toEqual({
      acquired: true,
      value: 'other',
    });

    release();
    expect(await working).toBe('started');
    expect(await b.computers.tryWithUserLock(userId, async () => 'swept')).toEqual({ acquired: true, value: 'swept' });
  });

  it('gives one process the DevTools connection at a time, re-entrant for the owner', async () => {
    const userId = `u-${randomUUID()}`;
    expect(await a.computers.tryLockCdpOwner(userId)).toBe(true);
    expect(await a.computers.tryLockCdpOwner(userId)).toBe(true); // the owner asking again
    expect(await b.computers.tryLockCdpOwner(userId)).toBe(false);
    // Re-entry does not stack: one unlock frees it.
    expect(await cdpLocksHeld(observer, userId)).toBe(1);

    await a.computers.unlockCdpOwner(userId);
    await a.computers.unlockCdpOwner(userId); // idempotent
    expect(await cdpLocksHeld(observer, userId)).toBe(0);
    expect(await b.computers.tryLockCdpOwner(userId)).toBe(true);
    expect(await a.computers.tryLockCdpOwner(userId)).toBe(false);
    await b.computers.unlockCdpOwner(userId);
  });

  it('tells the owner when another process waits for the DevTools connection', async () => {
    const userId = `u-${randomUUID()}`;
    expect(await a.computers.tryLockCdpOwner(userId)).toBe(true);
    expect(await a.computers.isCdpWanted(userId)).toBe(false);

    await b.computers.setCdpWanted(userId, true);
    await b.computers.setCdpWanted(userId, true); // idempotent
    expect(await a.computers.isCdpWanted(userId)).toBe(true);
    expect(await b.computers.isCdpWanted(userId)).toBe(false); // its own hand does not count

    await b.computers.setCdpWanted(userId, false);
    expect(await a.computers.isCdpWanted(userId)).toBe(false);
    await a.computers.unlockCdpOwner(userId);
    // Asking left nothing behind.
    const [row] = await observer.client.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM pg_locks
      WHERE locktype = 'advisory' AND granted
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${`greenhouse-bot-computer-cdp-want:${userId}`}, 0)`);
    expect(Number(row?.n ?? 0)).toBe(0);
  });

  it('frees the DevTools connection when the owning process dies', async () => {
    const userId = `u-${randomUUID()}`;
    const doomed = slot();
    expect(await doomed.computers.tryLockCdpOwner(userId)).toBe(true);
    expect(await a.computers.tryLockCdpOwner(userId)).toBe(false);

    // The process goes away: its connections close, and the database lets go.
    await doomed.client.client.end({ timeout: 0 });
    await expect.poll(() => cdpLocksHeld(observer, userId), { timeout: 5_000 }).toBe(0);
    expect(await a.computers.tryLockCdpOwner(userId)).toBe(true);
    await a.computers.unlockCdpOwner(userId);
  });
});
