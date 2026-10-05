/**
 * Bot computers service — the DB-authoritative lifecycle of each member's
 * computer (PostgreSQL).
 *
 * Two blue/green API slots share one Docker daemon and this table, so every
 * lifecycle decision is made here, never from in-process state:
 * - transitions are compare-and-set on `version`;
 * - start/stop/evict for one user run under a per-user advisory lock, and the
 *   capacity decision under one global lock (`withCapacityLock`);
 * - the take-over lease is `lease_controller` + a monotonically increasing
 *   `lease_epoch`; observations made under an older epoch are discarded;
 * - idle and auto-release read `viewer_heartbeat_at`, which whichever slot
 *   holds a live viewer socket refreshes;
 * - the computer's DevTools relay accepts ONE client, so one process at a
 *   time owns a member's browser connection (`tryLockCdpOwner`, a
 *   session-level lock the database frees by itself when that process dies).
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §6.
 */

import { and, asc, eq, inArray, lt, or, isNull, sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import { nowIso } from '@greenhouse/utils/date';

import type { Db, DbClient } from '../client.js';
import { botComputers } from '../schema/index.js';
import type { BotComputerRow, BotComputerState } from '../schema/bots.js';

/** Advisory-lock key space for computers (hashtext of a stable label + user id). */
const USER_LOCK_LABEL = 'greenhouse-bot-computer:';
const CAPACITY_LOCK_LABEL = 'greenhouse-bot-computer-capacity';
/** Key space of the DevTools owner lock (see `tryLockCdpOwner`). */
const CDP_OWNER_LOCK_LABEL = 'greenhouse-bot-computer-cdp:';
/** Key space of "a process is waiting for that DevTools connection" (see `setCdpWanted`). */
const CDP_WANT_LOCK_LABEL = 'greenhouse-bot-computer-cdp-want:';

export interface ComputerIdentity {
  user_id: string;
  namespace: string;
  container_name: string;
  volume_name: string;
}

export function createBotComputerService(db: Db) {
  const service = {
    async get(userId: string): Promise<BotComputerRow | undefined> {
      const [row] = await db.select().from(botComputers).where(eq(botComputers.user_id, userId));
      return row;
    },

    /** Insert the row on first use (state `absent`); returns the existing row otherwise. */
    async ensure(identity: ComputerIdentity): Promise<BotComputerRow> {
      const now = nowIso();
      await db
        .insert(botComputers)
        .values({
          user_id: identity.user_id,
          namespace: identity.namespace,
          container_name: identity.container_name,
          volume_name: identity.volume_name,
          state: 'absent',
          last_active_at: now,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing();
      return (await service.get(identity.user_id))!;
    },

    async list(): Promise<BotComputerRow[]> {
      return await db.select().from(botComputers).orderBy(asc(botComputers.user_id));
    },

    async listByStates(states: BotComputerState[]): Promise<BotComputerRow[]> {
      return await db.select().from(botComputers).where(inArray(botComputers.state, states));
    },

    async countRunning(): Promise<number> {
      const [row] = await db
        .select({ n: sql<string>`count(*)` })
        .from(botComputers)
        .where(inArray(botComputers.state, ['starting', 'running']));
      return Number(row?.n ?? 0);
    },

    /**
     * Compare-and-set a lifecycle transition. Succeeds only when the row is
     * still at `expectedVersion` and in one of `from`; bumps `version`.
     */
    async transition(
      userId: string,
      expectedVersion: number,
      from: BotComputerState[],
      patch: Partial<
        Pick<BotComputerRow, 'state' | 'state_reason' | 'image_id' | 'last_started_at' | 'container_name'>
      >,
    ): Promise<BotComputerRow | undefined> {
      const [row] = await db
        .update(botComputers)
        .set({ ...patch, version: sql`${botComputers.version} + 1`, updated_at: nowIso() })
        .where(
          and(
            eq(botComputers.user_id, userId),
            eq(botComputers.version, expectedVersion),
            inArray(botComputers.state, from),
          ),
        )
        .returning();
      return row;
    },

    /** Record activity (a Bot used the computer, a user opened the viewer). */
    async touch(userId: string): Promise<void> {
      await db.update(botComputers).set({ last_active_at: nowIso() }).where(eq(botComputers.user_id, userId));
    },

    async heartbeatViewer(userId: string): Promise<void> {
      const now = nowIso();
      await db
        .update(botComputers)
        .set({ viewer_heartbeat_at: now, last_active_at: now })
        .where(eq(botComputers.user_id, userId));
    },

    async setDisk(userId: string, bytes: number): Promise<void> {
      await db
        .update(botComputers)
        .set({ disk_bytes: bytes, disk_measured_at: nowIso() })
        .where(eq(botComputers.user_id, userId));
    },

    /**
     * Running computers that nobody is using: no viewer heartbeat since the
     * cutoff, nobody holding the take-over lease, no activity since the cutoff.
     * Oldest activity first (the eviction order).
     */
    async listIdle(cutoffIso: string): Promise<BotComputerRow[]> {
      return await db
        .select()
        .from(botComputers)
        .where(
          and(
            eq(botComputers.state, 'running'),
            eq(botComputers.lease_controller, 'bot'),
            lt(botComputers.last_active_at, cutoffIso),
            or(isNull(botComputers.viewer_heartbeat_at), lt(botComputers.viewer_heartbeat_at, cutoffIso)),
          ),
        )
        .orderBy(asc(botComputers.last_active_at));
    },

    // ─── Take-over lease ──────────────────────────────

    /**
     * Hand the screen and input to the user (or back to the Bots). Always bumps
     * the epoch so any Bot observation started before the change is dropped.
     * Returns the new row, or undefined when the lease was already there.
     */
    async setLease(userId: string, controller: 'bot' | 'user'): Promise<BotComputerRow | undefined> {
      const now = nowIso();
      const [row] = await db
        .update(botComputers)
        .set({
          lease_controller: controller,
          lease_epoch: sql`${botComputers.lease_epoch} + 1`,
          lease_since: now,
          last_active_at: now,
          updated_at: now,
        })
        .where(and(eq(botComputers.user_id, userId), sql`${botComputers.lease_controller} <> ${controller}`))
        .returning();
      return row;
    },

    /** Users holding the lease whose viewers have all been gone since the cutoff. */
    async listAbandonedLeases(cutoffIso: string): Promise<BotComputerRow[]> {
      return await db
        .select()
        .from(botComputers)
        .where(
          and(
            eq(botComputers.lease_controller, 'user'),
            or(isNull(botComputers.viewer_heartbeat_at), lt(botComputers.viewer_heartbeat_at, cutoffIso)),
          ),
        );
    },

    async delete(userId: string): Promise<void> {
      await db.delete(botComputers).where(eq(botComputers.user_id, userId));
    },

    // ─── Locks ────────────────────────────────────────

    /** Run `fn` holding this user's computer lock (transaction-scoped advisory lock). */
    async withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${USER_LOCK_LABEL + userId}))`);
        return await fn();
      });
    },

    /**
     * Run `fn` holding this user's computer lock only if nobody holds it right
     * now (pg_try_advisory_xact_lock — the sweeps' variant: a held lock means a
     * start or stop is at work on the row, so they skip it instead of queueing).
     */
    async tryWithUserLock<T>(
      userId: string,
      fn: () => Promise<T>,
    ): Promise<{ acquired: true; value: T } | { acquired: false }> {
      return await db.transaction(async (tx) => {
        const [row] = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtext(${USER_LOCK_LABEL + userId})) AS locked`,
        );
        if (!row?.locked) return { acquired: false as const };
        return { acquired: true as const, value: await fn() };
      });
    },

    /** Run `fn` holding the global capacity lock. */
    async withCapacityLock<T>(fn: () => Promise<T>): Promise<T> {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${CAPACITY_LOCK_LABEL}))`);
        return await fn();
      });
    },

    /**
     * Claim the DevTools connection of this user's computer for this process
     * (blue/green slots share the computer; its relay takes one client, and a
     * second one kicks the first mid-action). A session-level advisory lock on
     * ONE reserved connection per process, held for every member this process
     * owns: the database frees it by itself when the process dies, and the
     * connection goes back to the pool once nothing is held. True when this
     * process holds it — including when it already did (re-checked on the
     * connection, so a connection that died with its locks is noticed here).
     * Throws when the lock cannot be checked.
     */
    tryLockCdpOwner(userId: string): Promise<boolean> {
      return serialLock(async () => {
        const conn = await lockConnection();
        if (!conn) return true; // no raw client (mock / transaction provider): in-process ownership only
        try {
          if (heldCdpLocks.has(userId)) {
            await conn`SELECT 1`;
            return true;
          }
          const [row] = await conn<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_lock(hashtextextended(${CDP_OWNER_LOCK_LABEL + userId}, 0)) AS locked`;
          if (!row?.locked) {
            releaseIfIdle();
            return false;
          }
          heldCdpLocks.add(userId);
          return true;
        } catch (error) {
          dropLockConnection();
          throw error;
        }
      });
    },

    /** Release `tryLockCdpOwner` (idempotent; a lost connection already released it). */
    unlockCdpOwner(userId: string): Promise<void> {
      return serialLock(async () => {
        if (!heldCdpLocks.delete(userId) || !reserved) return;
        try {
          await reserved`SELECT pg_advisory_unlock(hashtextextended(${CDP_OWNER_LOCK_LABEL + userId}, 0))`;
        } catch {
          dropLockConnection();
          return;
        }
        releaseIfIdle();
      });
    },

    /**
     * A process waiting for this user's DevTools raises (`true`) or lowers its
     * hand, so the owner knows to let go once it is idle — and otherwise keeps
     * its connection (and with it the Bots' element refs). Another waiter's
     * raised hand is just as good, so failing to take it is fine. Best effort.
     */
    setCdpWanted(userId: string, wanted: boolean): Promise<void> {
      return serialLock(async () => {
        if (wanted === cdpWants.has(userId)) return;
        const conn = await lockConnection();
        if (!conn) return;
        try {
          if (wanted) {
            const [row] = await conn<Array<{ locked: boolean }>>`
              SELECT pg_try_advisory_lock(hashtextextended(${CDP_WANT_LOCK_LABEL + userId}, 0)) AS locked`;
            if (row?.locked) cdpWants.add(userId);
          } else {
            cdpWants.delete(userId);
            await conn`SELECT pg_advisory_unlock(hashtextextended(${CDP_WANT_LOCK_LABEL + userId}, 0))`;
          }
          releaseIfIdle();
        } catch (error) {
          dropLockConnection();
          throw error;
        }
      });
    },

    /** Whether another process has its hand up for this user's DevTools (see setCdpWanted). */
    isCdpWanted(userId: string): Promise<boolean> {
      return serialLock(async () => {
        if (cdpWants.has(userId)) return false; // only our own hand
        const conn = await lockConnection();
        if (!conn) return false;
        try {
          const [row] = await conn<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_lock(hashtextextended(${CDP_WANT_LOCK_LABEL + userId}, 0)) AS locked`;
          if (!row?.locked) return true;
          await conn`SELECT pg_advisory_unlock(hashtextextended(${CDP_WANT_LOCK_LABEL + userId}, 0))`;
          return false;
        } catch (error) {
          dropLockConnection();
          throw error;
        } finally {
          releaseIfIdle();
        }
      });
    },
  };

  // ── The DevTools-owner lock connection (see tryLockCdpOwner) ──
  // Same shape as the conversation-run lock in bots.ts: every lock operation
  // is serialised, so the connection is never handed back while another
  // operation is about to use it.
  type ReservedSql = Awaited<ReturnType<DbClient['client']['reserve']>>;
  const heldCdpLocks = new Set<string>();
  const cdpWants = new Set<string>();
  let reserved: ReservedSql | null = null;
  let lockOps: Promise<unknown> = Promise.resolve();
  function serialLock<T>(op: () => Promise<T>): Promise<T> {
    const next = lockOps.then(op, op);
    lockOps = next.catch(() => undefined);
    return next;
  }
  async function lockConnection(): Promise<ReservedSql | null> {
    if (reserved) return reserved;
    // A transaction-scoped provider (integration tests) has no pool to reserve from.
    if ((db as unknown) instanceof PgTransaction) return null;
    const client = (db as unknown as { $client?: DbClient['client'] }).$client;
    if (!client || typeof client.reserve !== 'function') return null;
    reserved = await client.reserve();
    return reserved;
  }
  /** Nothing held: the connection (now without locks) goes back to the pool. */
  function releaseIfIdle(): void {
    if (heldCdpLocks.size > 0 || cdpWants.size > 0 || !reserved) return;
    const conn = reserved;
    reserved = null;
    conn.release();
  }
  /**
   * The connection failed: forget its locks. A connection that is still alive
   * goes back to the pool and the pool's idle timeout closes it, releasing
   * whatever it held.
   */
  function dropLockConnection(): void {
    const conn = reserved;
    reserved = null;
    heldCdpLocks.clear();
    cdpWants.clear();
    try {
      conn?.release();
    } catch {
      // Already gone.
    }
  }

  return service;
}

export type BotComputerService = ReturnType<typeof createBotComputerService>;
