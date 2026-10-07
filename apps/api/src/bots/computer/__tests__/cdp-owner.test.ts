/**
 * DevTools ownership between two simulated API processes sharing one fake
 * lock (the real lock is proven in packages/db bot-computers.db-commit.test):
 * one owner at a time, a bounded wait that ends in a retryable `busy`, the
 * owner letting go only when idle AND someone waits — connection first, then
 * the lock — and `fresh` telling a new claim from one this process already held.
 */

import { describe, expect, it, vi } from 'vitest';
import { createCdpOwnership, type CdpOwnerStore } from '../cdp-owner.js';
import { ComputerUnavailableError } from '../errors.js';

/** One database's advisory locks, seen by several processes. */
function fakeLocks() {
  const owners = new Map<string, string>();
  /** Raised hands: member → the processes waiting for that browser. */
  const wants = new Map<string, Set<string>>();
  const store = (process: string): CdpOwnerStore & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      tryLockCdpOwner: async (userId) => {
        calls.push(`lock ${userId}`);
        const owner = owners.get(userId);
        if (owner && owner !== process) return false;
        owners.set(userId, process);
        return true;
      },
      unlockCdpOwner: async (userId) => {
        calls.push(`unlock ${userId}`);
        if (owners.get(userId) === process) owners.delete(userId);
      },
      setCdpWanted: async (userId, wanted) => {
        const set = wants.get(userId) ?? new Set<string>();
        if (wanted) set.add(process);
        else set.delete(process);
        wants.set(userId, set);
      },
      isCdpWanted: async (userId) => [...(wants.get(userId) ?? [])].some((p) => p !== process),
    };
  };
  return { owners, wants, store };
}

const fast = { waitMs: 160, pollMs: 10, idleMs: 60, checkMs: 15 };

function processWith(locks: ReturnType<typeof fakeLocks>, name: string, overrides: Partial<typeof fast> = {}) {
  const store = locks.store(name);
  const log: string[] = [];
  const ownership = createCdpOwnership({
    store: () => store,
    disconnect: (userId) => log.push(`disconnect ${userId}`),
    ...fast,
    ...overrides,
  });
  return { ownership, store, log };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('DevTools ownership', () => {
  it('gives the browser to one process; the other waits, then gets a retryable busy', async () => {
    const locks = fakeLocks();
    const blue = processWith(locks, 'blue');
    const green = processWith(locks, 'green');

    expect(await blue.ownership.claim('u1')).toEqual({ fresh: true });
    blue.ownership.begin('u1'); // an action keeps it busy past the other's wait

    const started = Date.now();
    const err = await green.ownership.claim('u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComputerUnavailableError);
    expect(err).toMatchObject({ code: 'busy' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(fast.waitMs);
    expect(green.store.calls.length).toBeGreaterThan(2); // it polled
    expect(locks.owners.get('u1')).toBe('blue');
    expect(locks.wants.get('u1')?.size).toBe(0); // gave up: hand down
    blue.ownership.end('u1');
    await blue.ownership.release('u1');
  });

  it('keeps an idle browser while nobody waits (the Bots keep their element refs)', async () => {
    const locks = fakeLocks();
    const blue = processWith(locks, 'blue');
    await blue.ownership.claim('u1');
    await sleep(fast.idleMs * 3);
    expect(blue.ownership.holds('u1')).toBe(true);
    expect(blue.log).toEqual([]);
    await blue.ownership.release('u1');
  });

  it('hands an idle browser to a waiting process — never under an action in flight; connection first, then the lock', async () => {
    const locks = fakeLocks();
    const blue = processWith(locks, 'blue');
    const green = processWith(locks, 'green', { waitMs: 1_000 });
    await blue.ownership.claim('u1');

    blue.ownership.begin('u1');
    const waiting = green.ownership.claim('u1').catch((e: unknown) => e);
    await sleep(fast.idleMs * 2);
    expect(blue.ownership.holds('u1')).toBe(true); // green's hand is up, but blue is mid-action
    expect(locks.wants.get('u1')).toEqual(new Set(['green']));
    blue.ownership.end('u1');

    // Green was waiting: it gets the browser once blue has been quiet long enough.
    expect(await waiting).toEqual({ fresh: true });
    expect(blue.ownership.holds('u1')).toBe(false);
    expect(blue.log).toEqual(['disconnect u1']);
    expect(blue.store.calls.at(-1)).toBe('unlock u1');
    expect(locks.wants.get('u1')?.size).toBe(0); // hand down once served
    await green.ownership.release('u1');
  });

  it('keeps the browser while it is being used, and re-checks the lock on every claim', async () => {
    const locks = fakeLocks();
    const blue = processWith(locks, 'blue');
    await blue.ownership.claim('u1');
    for (let i = 0; i < 4; i++) {
      await sleep(fast.idleMs / 2);
      blue.ownership.touch('u1');
    }
    expect(blue.ownership.holds('u1')).toBe(true);
    // Already ours: not fresh, but still asked of the database (the lock
    // connection may have died with its locks).
    expect(await blue.ownership.claim('u1')).toEqual({ fresh: false });
    expect(blue.store.calls.filter((c) => c === 'lock u1')).toHaveLength(2);
    await blue.ownership.release('u1');
    await blue.ownership.release('u1'); // idempotent
    expect(blue.log).toEqual(['disconnect u1']);
  });

  it('notices a lock lost with its connection, and waits like any non-owner', async () => {
    const locks = fakeLocks();
    const blue = processWith(locks, 'blue');
    await blue.ownership.claim('u1');
    locks.owners.set('u1', 'green'); // blue's lock connection died; green claimed meanwhile
    await expect(blue.ownership.claim('u1')).rejects.toMatchObject({ code: 'busy' });
    expect(blue.ownership.holds('u1')).toBe(false);
  });

  it('asks the database once for concurrent claims in one process', async () => {
    const locks = fakeLocks();
    const blue = processWith(locks, 'blue');
    const claims = await Promise.all([blue.ownership.claim('u1'), blue.ownership.claim('u1')]);
    expect(claims).toEqual([{ fresh: true }, { fresh: true }]);
    expect(blue.store.calls).toEqual(['lock u1']);
    await blue.ownership.releaseAll();
    expect(locks.owners.size).toBe(0);
  });

  it('fails closed with `unavailable` when the lock cannot be checked', async () => {
    const ownership = createCdpOwnership({
      store: () => ({
        tryLockCdpOwner: vi.fn(async () => {
          throw new Error('connection refused');
        }),
        unlockCdpOwner: vi.fn(async () => undefined),
        setCdpWanted: vi.fn(async () => undefined),
        isCdpWanted: vi.fn(async () => false),
      }),
      disconnect: vi.fn(),
      ...fast,
    });
    await expect(ownership.claim('u1')).rejects.toMatchObject({ code: 'unavailable' });
    expect(ownership.holds('u1')).toBe(false);
  });
});
