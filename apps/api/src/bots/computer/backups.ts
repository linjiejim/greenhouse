/**
 * Bot computer backups — an encrypted copy of each member's home in the deployment's own
 * storage (backup-store.ts), so the provider (or the Docker host) never holds the only one.
 *
 * - When: as an idle computer goes to sleep, at most every `hours`
 *   (BOTS_COMPUTER_BACKUP_HOURS) — the controller's idle loop waits for it, up to
 *   BACKUP_DEFER_MS past the idle time — and on an administrator's "Back up now".
 * - What: both homes streamed out as their own uid (host.exportHome: gzip'd tar, caches
 *   left out), encrypted in the API with the backup's own random AES-256 key
 *   (backup-format.ts), stored as two objects. The key is kept sealed with the vault's key
 *   (`gv1.<key id>`, AAD bound to member and backup; `pnpm cli vault rekey` rotates it).
 *   The storage never sees a file or a key.
 * - Restore: into a new computer when the member's previous one is gone — deleted, another
 *   provider, another driver (ComputerStartSpec.restore): the newest complete backup. One
 *   whose objects are missing or fail authentication is marked failed and never tried again;
 *   one whose key cannot be opened (no vault key) fails the start instead, for an
 *   administrator to fix — a member's files are never silently swapped for an empty home.
 * - Kept: the newest `keep` complete backups per member. Deleted with the member's home
 *   (a wipe, the member deleted); a sweep ends backups whose process died and deletes those
 *   whose member is gone.
 *
 * Design: docs/specs/20261010-hosted-computer-sandbox.md (P2b).
 */

import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { BotComputerBackupRow, BotComputerRow, BotComputerService } from '@greenhouse/db';

import { isCurrentVaultCiphertext, openWithVaultKey, sealWithVaultKey } from '../vault/crypto.js';
import { BackupFormatError, decryptBackupStream, encryptBackupStream } from './backup-format.js';
import { BackupStoreError, type BackupStore } from './backup-store.js';
import { exportSucceeded, HOME_USERS, homeOf } from './home-archive.js';
import {
  ComputerStartError,
  type ComputerHost,
  type ComputerProcess,
  type ComputerUser,
  type HomeRestore,
} from './host.js';

/** One backup, both homes. */
export const BACKUP_TIMEOUT_MS = 45 * 60_000;
/** An idle computer waits this long past its idle time for its backup, then sleeps anyway. */
export const BACKUP_DEFER_MS = 60 * 60_000;
/** After a failed backup, the next one waits this long. */
export const BACKUP_RETRY_MS = 60 * 60_000;
/** Backups at once, per API process. */
export const BACKUP_CONCURRENCY = 2;
/** Failed backups kept (newer than the newest complete one) for the admin page. */
const FAILED_KEPT = 3;

type BackupDb = Pick<
  BotComputerService,
  | 'startBackup'
  | 'completeBackup'
  | 'failBackup'
  | 'getBackup'
  | 'listComputerBackups'
  | 'latestCompleteBackup'
  | 'listAllBackups'
  | 'listStaleBackups'
  | 'listOrphanBackups'
  | 'markBackupRestored'
  | 'deleteBackup'
>;

export interface ComputerBackupsDeps {
  db: BackupDb;
  store: BackupStore;
  host: () => ComputerHost;
  hours: number;
  keep: number;
  now?: () => number;
}

/** What the admin page shows per member. */
export interface BackupSummary {
  /** The newest backup of any status. */
  status: BotComputerBackupRow['status'];
  at: string;
  error: string | null;
  /** The newest complete one. */
  last_complete_at: string | null;
  last_complete_bytes: number | null;
}

export function backupKeyAad(userId: string, backupId: string): string {
  return `computer-backup:${userId}:${backupId}`;
}

export function backupObjectKey(backup: { user_id: string; id: string }, user: ComputerUser): string {
  return `${backup.user_id}/${backup.id}/${user}`;
}

function streamLabel(backupId: string, user: ComputerUser): string {
  return `${backupId}:${user}`;
}

/** A process's exit code and the tail of its stderr. */
function exited(proc: ComputerProcess): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    proc.once('error', () => {});
    proc.once('close', (code) => resolve({ code, stderr }));
  });
}

export function createComputerBackups(deps: ComputerBackupsDeps) {
  const now = deps.now ?? Date.now;
  /** Backups this process is taking, per computer. */
  const inFlight = new Map<string, Promise<BotComputerBackupRow | null>>();

  const ageMs = (iso: string | null | undefined): number => (iso ? now() - Date.parse(iso) : Infinity);

  /** due: take one; fresh: the newest is recent enough (or failing: wait); running: one is under way. */
  async function backupState(computerId: string): Promise<'due' | 'fresh' | 'running'> {
    const rows = await deps.db.listComputerBackups(computerId);
    const latest = rows[0];
    if (latest?.status === 'running' && ageMs(latest.created_at) < BACKUP_TIMEOUT_MS) return 'running';
    if (latest?.status === 'failed' && ageMs(latest.completed_at ?? latest.created_at) < BACKUP_RETRY_MS)
      return 'fresh';
    const complete = rows.find((row) => row.status === 'complete');
    return complete && ageMs(complete.completed_at) < deps.hours * 3_600_000 ? 'fresh' : 'due';
  }

  async function removeObjects(backup: { user_id: string; id: string }): Promise<void> {
    for (const user of HOME_USERS) {
      await deps.store.remove(backupObjectKey(backup, user)).catch((err) => {
        logger.warn(
          `[bots-computer] could not delete backup object ${backupObjectKey(backup, user)}: ${toErrorMessage(err)}`,
        );
      });
    }
  }

  async function drop(backup: BotComputerBackupRow): Promise<void> {
    await removeObjects(backup);
    await deps.db.deleteBackup(backup.id);
  }

  /** Keep the newest `keep` complete backups, and a few failures newer than them. */
  async function prune(computerId: string): Promise<void> {
    const rows = await deps.db.listComputerBackups(computerId);
    const complete = rows.filter((row) => row.status === 'complete');
    const newestComplete = complete[0];
    const failedNewer = rows.filter(
      (row) =>
        row.status === 'failed' &&
        (!newestComplete || Date.parse(row.created_at) > Date.parse(newestComplete.created_at)),
    );
    const failedOlder = rows.filter((row) => row.status === 'failed' && !failedNewer.includes(row));
    for (const row of [...complete.slice(deps.keep), ...failedNewer.slice(FAILED_KEPT), ...failedOlder]) {
      await drop(row);
    }
  }

  /** One home out, encrypted, into the store; resolves with the stored size. */
  async function exportOne(
    host: ComputerHost,
    backup: BotComputerBackupRow,
    user: ComputerUser,
    key: Buffer,
    deadline: number,
  ): Promise<number> {
    const proc = host.exportHome(backup.source_ref, user);
    const exit = exited(proc);
    const timer = setTimeout(() => proc.kill('SIGKILL'), Math.max(1, deadline - now()));
    try {
      if (!proc.stdout) throw new Error('The export has no output');
      const sealed = encryptBackupStream(key, streamLabel(backup.id, user));
      proc.stdout.once('error', (err) => sealed.destroy(err));
      const [bytes, outcome] = await Promise.all([
        deps.store.write(backupObjectKey(backup, user), proc.stdout.pipe(sealed)),
        exit,
      ]);
      // A cut export still ends its stream cleanly — only the exit code tells.
      if (!exportSucceeded(outcome.code)) {
        throw new Error(`Packing ${homeOf(user)} failed (exit ${outcome.code}): ${outcome.stderr.trim().slice(-300)}`);
      }
      return bytes;
    } catch (err) {
      proc.kill('SIGKILL');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Take one backup of a running computer. Never throws: the row says how it went (null = another took it). */
  async function take(
    row: BotComputerRow,
    reason: BotComputerBackupRow['reason'],
  ): Promise<BotComputerBackupRow | null> {
    const host = deps.host();
    const id = `bkp_${randomBytes(10).toString('hex')}`;
    const key = randomBytes(32);
    let started: BotComputerBackupRow | null;
    try {
      started = await deps.db.startBackup({
        id,
        user_id: row.user_id,
        computer_id: row.id,
        reason,
        store: deps.store.kind,
        key_enc: sealWithVaultKey(backupKeyAad(row.user_id, id), key.toString('base64')),
        driver: host.kind,
        source_ref: row.container_name,
      });
    } catch (err) {
      logger.warn(`[bots-computer] could not start a backup of ${row.id}: ${toErrorMessage(err)}`);
      return null;
    }
    if (!started) return null;
    const startedAt = now();
    try {
      let bytes = 0;
      for (const user of HOME_USERS) bytes += await exportOne(host, started, user, key, startedAt + BACKUP_TIMEOUT_MS);
      const done = await deps.db.completeBackup(id, bytes);
      // Ended meanwhile: swept as stale, or deleted with the member's home.
      if (!done) throw new Error('The backup was ended while it ran');
      logger.info('[bots-computer] backed up a computer', {
        computer_id: row.id,
        backup: id,
        reason,
        bytes,
        store: deps.store.kind,
        duration_ms: now() - startedAt,
      });
      await prune(row.id).catch((err) => {
        logger.warn(`[bots-computer] pruning the backups of ${row.id} failed: ${toErrorMessage(err)}`);
      });
      return done;
    } catch (err) {
      logger.warn('[bots-computer] backup failed', {
        computer_id: row.id,
        backup: id,
        error: toErrorMessage(err),
        duration_ms: now() - startedAt,
      });
      await removeObjects(started);
      const failed = await deps.db.failBackup(id, toErrorMessage(err)).catch(() => undefined);
      return failed ?? (await deps.db.getBackup(id).catch(() => undefined)) ?? null;
    }
  }

  /** Take a backup of a running computer now (one per computer at a time); resolves when it ends. */
  function start(row: BotComputerRow, reason: BotComputerBackupRow['reason']): Promise<BotComputerBackupRow | null> {
    const running = inFlight.get(row.id);
    if (running) return running;
    const run = take(row, reason).finally(() => inFlight.delete(row.id));
    inFlight.set(row.id, run);
    return run;
  }

  async function markUnusable(backup: BotComputerBackupRow, err: unknown): Promise<void> {
    logger.warn('[bots-computer] a backup cannot be restored; it is never used again', {
      computer_id: backup.computer_id,
      backup: backup.id,
      error: toErrorMessage(err),
    });
    await deps.db.failBackup(backup.id, `Unreadable: ${toErrorMessage(err)}`).catch(() => {});
  }

  return {
    store: deps.store,
    hours: deps.hours,
    keep: deps.keep,

    /**
     * Before the idle loop stops a computer: 'wait' while its backup runs (starting one when
     * it is due), 'go' once it is fresh — or when the computer has waited BACKUP_DEFER_MS.
     */
    async beforeSleep(row: BotComputerRow, idleMinutes: number): Promise<'go' | 'wait'> {
      const overdue = ageMs(row.last_active_at) > idleMinutes * 60_000 + BACKUP_DEFER_MS;
      if (inFlight.has(row.id)) return overdue ? 'go' : 'wait';
      const state = await backupState(row.id);
      if (state === 'fresh' || overdue) return 'go';
      // Another API process is taking it.
      if (state === 'running') return 'wait';
      if (inFlight.size >= BACKUP_CONCURRENCY) return 'wait';
      void start(row, 'idle');
      return 'wait';
    },

    start,

    /** ComputerStartSpec.restore: the newest complete backup, ready to stream back. */
    async restoreSource(computerId: string): Promise<HomeRestore | null> {
      const backup = await deps.db.latestCompleteBackup(computerId);
      if (!backup) return null;
      let key: Buffer;
      try {
        key = Buffer.from(
          openWithVaultKey(backupKeyAad(backup.user_id, backup.id), backup.key_enc, 'This backup'),
          'base64',
        );
      } catch (err) {
        throw new ComputerStartError(
          'restore_failed',
          `The backup of ${backup.completed_at} cannot be opened: ${toErrorMessage(err)}`,
          { cause: err },
        );
      }
      return {
        backupId: backup.id,
        takenAt: backup.completed_at ?? backup.created_at,
        open: async (user: ComputerUser): Promise<Readable> => {
          let stored: Readable;
          try {
            stored = await deps.store.read(backupObjectKey(backup, user));
          } catch (err) {
            if (err instanceof BackupStoreError && err.code === 'missing') await markUnusable(backup, err);
            throw err;
          }
          const plain = decryptBackupStream(key, streamLabel(backup.id, user));
          stored.once('error', (err) => plain.destroy(err));
          plain.once('error', (err) => {
            if (err instanceof BackupFormatError) void markUnusable(backup, err);
          });
          return stored.pipe(plain);
        },
      };
    },

    /** A start put this backup into a new home. */
    async restored(backupId: string): Promise<void> {
      await deps.db.markBackupRestored(backupId);
    },

    /** A computer's home is gone for good (a wipe, the member deleted): so are its backups. */
    async deleteAll(computerId: string): Promise<void> {
      for (const backup of await deps.db.listComputerBackups(computerId)) await drop(backup);
    },

    /** End backups whose process died, and delete those whose member is gone. */
    async sweep(): Promise<void> {
      const cutoff = new Date(now() - BACKUP_TIMEOUT_MS - 15 * 60_000).toISOString();
      for (const backup of await deps.db.listStaleBackups(cutoff)) {
        if (inFlight.has(backup.computer_id)) continue;
        await removeObjects(backup);
        await deps.db.failBackup(backup.id, 'The API process taking it stopped');
      }
      for (const backup of await deps.db.listOrphanBackups()) await drop(backup);
    },

    /** Per computer: the newest backup and the newest complete one. */
    async summaries(): Promise<Map<string, BackupSummary>> {
      const out = new Map<string, BackupSummary>();
      for (const row of await deps.db.listAllBackups()) {
        const summary = out.get(row.computer_id);
        if (!summary) {
          out.set(row.computer_id, {
            status: row.status,
            at: row.completed_at ?? row.created_at,
            error: row.error,
            last_complete_at: row.status === 'complete' ? row.completed_at : null,
            last_complete_bytes: row.status === 'complete' ? row.bytes : null,
          });
        } else if (summary.last_complete_at === null && row.status === 'complete') {
          summary.last_complete_at = row.completed_at;
          summary.last_complete_bytes = row.bytes;
        }
      }
      return out;
    },

    /**
     * When the backup the member's current computer began from was taken — if this run began
     * with one (it is marked restored once the computer is running, after `last_started_at`).
     */
    async restoredInto(computerId: string, lastStartedAt: string | null): Promise<string | null> {
      if (!lastStartedAt) return null;
      const rows = await deps.db.listComputerBackups(computerId);
      const restored = rows.find((row) => row.restored_at && Date.parse(row.restored_at) >= Date.parse(lastStartedAt));
      return restored ? (restored.completed_at ?? restored.created_at) : null;
    },
  };
}

export type ComputerBackups = ReturnType<typeof createComputerBackups>;

/**
 * Re-seal every backup's key under the vault's current key (`pnpm cli vault rekey`, next to the
 * vault's own entries). Cheap: only the sealed keys change, never the stored objects. A key no
 * known vault key opens is reported and left as it is (that backup can no longer be restored).
 */
export async function rekeyBackupKeys(
  db: Pick<BotComputerService, 'listBackupKeys' | 'replaceBackupKey'>,
  opts: { dryRun?: boolean } = {},
): Promise<{ keys: number; rekeyed: number; unreadable: string[] }> {
  const result = { keys: 0, rekeyed: 0, unreadable: [] as string[] };
  for (const row of await db.listBackupKeys()) {
    result.keys++;
    if (isCurrentVaultCiphertext(row.key_enc)) continue;
    const aad = backupKeyAad(row.user_id, row.id);
    let sealed: string;
    try {
      sealed = sealWithVaultKey(aad, openWithVaultKey(aad, row.key_enc));
    } catch {
      result.unreadable.push(row.id);
      continue;
    }
    // A backup deleted meanwhile has nothing left to re-seal.
    if (opts.dryRun || (await db.replaceBackupKey(row.id, row.key_enc, sealed))) result.rekeyed++;
  }
  return result;
}
