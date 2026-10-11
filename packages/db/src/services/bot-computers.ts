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

import { and, asc, desc, eq, getTableColumns, inArray, lt, or, isNull, sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import { nowIso } from '@greenhouse/utils/date';

import type { Db, DbClient } from '../client.js';
import { botComputerBackups, botComputers, botProcessWatches, users } from '../schema/index.js';
import type {
  BotComputerBackupRow,
  BotComputerRow,
  BotComputerState,
  BotProcessWatchRow,
  BotProcessWatchStatus,
} from '../schema/bots.js';

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

/** A process a Bot asked to hear about (run_background in a conversation). */
export interface ProcessWatchInput {
  user_id: string;
  session_id: string;
  bot_id: string;
  job_id: string;
  name: string;
}

/** A backup as it starts (the runtime has sealed its key already). */
export type ComputerBackupInput = Pick<
  typeof botComputerBackups.$inferInsert,
  'id' | 'user_id' | 'reason' | 'store' | 'key_enc' | 'driver' | 'source_ref'
>;

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
     * The member's own timezone for the computer (an IANA name the caller has
     * validated; null = the deployment default), applied at the next start.
     * Creates the row on first use — the page sets it before the computer
     * ever ran. Not a lifecycle change: no `version` bump, and `updated_at`
     * keeps dating the last transition (the sweeps judge stale rows by it).
     */
    async setTimezone(identity: ComputerIdentity, timezone: string | null): Promise<BotComputerRow> {
      const now = nowIso();
      const [row] = await db
        .insert(botComputers)
        .values({
          user_id: identity.user_id,
          namespace: identity.namespace,
          container_name: identity.container_name,
          volume_name: identity.volume_name,
          state: 'absent',
          timezone,
          last_active_at: now,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({ target: botComputers.user_id, set: { timezone } })
        .returning();
      return row!;
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

    // ─── Process watches ──────────────────────────────

    /** A Bot wants to hear when this background process ends (once per job). */
    async watchProcess(input: ProcessWatchInput): Promise<void> {
      const now = nowIso();
      await db
        .insert(botProcessWatches)
        .values({ ...input, status: 'watching', created_at: now, updated_at: now })
        .onConflictDoNothing({ target: [botProcessWatches.user_id, botProcessWatches.job_id] });
    },

    /** Members with at least one process still watched. */
    async listWatchingUsers(): Promise<string[]> {
      const rows = await db
        .selectDistinct({ user_id: botProcessWatches.user_id })
        .from(botProcessWatches)
        .where(eq(botProcessWatches.status, 'watching'));
      return rows.map((row) => row.user_id);
    },

    async listWatches(userId: string): Promise<BotProcessWatchRow[]> {
      return db
        .select()
        .from(botProcessWatches)
        .where(and(eq(botProcessWatches.user_id, userId), eq(botProcessWatches.status, 'watching')))
        .orderBy(asc(botProcessWatches.id));
    },

    /**
     * Settle a watch — only if it is still `watching`: the row comes back to exactly one
     * caller, so of several API processes only one wakes the Bot.
     */
    async settleWatch(
      id: number,
      status: Exclude<BotProcessWatchStatus, 'watching'>,
    ): Promise<BotProcessWatchRow | undefined> {
      const [row] = await db
        .update(botProcessWatches)
        .set({ status, updated_at: nowIso() })
        .where(and(eq(botProcessWatches.id, id), eq(botProcessWatches.status, 'watching')))
        .returning();
      return row;
    },

    /** Give up on watches older than `cutoffIso` (a process that never ends must not be asked about for ever). */
    async expireWatches(cutoffIso: string): Promise<number> {
      const rows = await db
        .update(botProcessWatches)
        .set({ status: 'gone', updated_at: nowIso() })
        .where(and(eq(botProcessWatches.status, 'watching'), lt(botProcessWatches.created_at, cutoffIso)))
        .returning({ id: botProcessWatches.id });
      return rows.length;
    },

    /** The member's computer and its home are gone: nothing it ran can end any more. */
    async dropWatches(userId: string): Promise<void> {
      await db
        .update(botProcessWatches)
        .set({ status: 'gone', updated_at: nowIso() })
        .where(and(eq(botProcessWatches.user_id, userId), eq(botProcessWatches.status, 'watching')));
    },

    // ─── Backups ──────────────────────────────────────

    /** Start a backup; null when the member already has one running (another API process took it). */
    async startBackup(input: ComputerBackupInput): Promise<BotComputerBackupRow | null> {
      const [row] = await db
        .insert(botComputerBackups)
        .values({ ...input, status: 'running', created_at: nowIso() })
        // The partial unique index: one running backup per member.
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },

    /** A running backup is complete — only if it is still running. */
    async completeBackup(id: string, bytes: number): Promise<BotComputerBackupRow | undefined> {
      const [row] = await db
        .update(botComputerBackups)
        .set({ status: 'complete', bytes, completed_at: nowIso() })
        .where(and(eq(botComputerBackups.id, id), eq(botComputerBackups.status, 'running')))
        .returning();
      return row;
    },

    /**
     * A backup failed: one still running, or a complete one found unreadable (it is never
     * restored again). Returns the row only when it changed.
     */
    async failBackup(id: string, error: string): Promise<BotComputerBackupRow | undefined> {
      const [row] = await db
        .update(botComputerBackups)
        .set({ status: 'failed', error: error.slice(0, 500), completed_at: nowIso() })
        .where(and(eq(botComputerBackups.id, id), inArray(botComputerBackups.status, ['running', 'complete'])))
        .returning();
      return row;
    },

    async getBackup(id: string): Promise<BotComputerBackupRow | undefined> {
      const [row] = await db.select().from(botComputerBackups).where(eq(botComputerBackups.id, id));
      return row;
    },

    /** A member's backups, newest first (every status). */
    async listBackups(userId: string): Promise<BotComputerBackupRow[]> {
      return db
        .select()
        .from(botComputerBackups)
        .where(eq(botComputerBackups.user_id, userId))
        .orderBy(desc(botComputerBackups.created_at), desc(botComputerBackups.id));
    },

    /** The newest complete backup of a member — what a new computer is restored from. */
    async latestCompleteBackup(userId: string): Promise<BotComputerBackupRow | undefined> {
      const [row] = await db
        .select()
        .from(botComputerBackups)
        .where(and(eq(botComputerBackups.user_id, userId), eq(botComputerBackups.status, 'complete')))
        .orderBy(desc(botComputerBackups.completed_at), desc(botComputerBackups.id))
        .limit(1);
      return row;
    },

    /** Every member's backups (the admin page; a handful per member). */
    async listAllBackups(): Promise<BotComputerBackupRow[]> {
      return db.select().from(botComputerBackups).orderBy(desc(botComputerBackups.created_at));
    },

    /** Backups still `running` that started before `cutoffIso`: their process died. */
    async listStaleBackups(cutoffIso: string): Promise<BotComputerBackupRow[]> {
      return db
        .select()
        .from(botComputerBackups)
        .where(and(eq(botComputerBackups.status, 'running'), lt(botComputerBackups.created_at, cutoffIso)));
    },

    /** Backups whose member no longer exists (deleted while the computer runtime was down). */
    async listOrphanBackups(): Promise<BotComputerBackupRow[]> {
      return db
        .select(getTableColumns(botComputerBackups))
        .from(botComputerBackups)
        .leftJoin(users, eq(users.id, botComputerBackups.user_id))
        .where(isNull(users.id));
    },

    async markBackupRestored(id: string): Promise<void> {
      await db.update(botComputerBackups).set({ restored_at: nowIso() }).where(eq(botComputerBackups.id, id));
    },

    /** The row only — its objects are deleted first (backups.ts). */
    async deleteBackup(id: string): Promise<void> {
      await db.delete(botComputerBackups).where(eq(botComputerBackups.id, id));
    },

    /** Every sealed backup key (`pnpm cli vault rekey` puts them under the current vault key). */
    async listBackupKeys(): Promise<Array<{ id: string; user_id: string; key_enc: string }>> {
      return db
        .select({ id: botComputerBackups.id, user_id: botComputerBackups.user_id, key_enc: botComputerBackups.key_enc })
        .from(botComputerBackups)
        .orderBy(botComputerBackups.id);
    },

    /** Swap a sealed key for the same key under another vault key — only while it is still what was read. */
    async replaceBackupKey(id: string, from: string, to: string): Promise<boolean> {
      const rows = await db
        .update(botComputerBackups)
        .set({ key_enc: to })
        .where(and(eq(botComputerBackups.id, id), eq(botComputerBackups.key_enc, from)))
        .returning({ id: botComputerBackups.id });
      return rows.length > 0;
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
