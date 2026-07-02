/**
 * Expired-export sweep — periodic cleanup of stale local-disk downloads.
 *
 * System-level job (not in the scheduled_tasks table). Generated exports encode
 * their own expiry in the id (exp_<epoch>_…); the GET route reaps one lazily when
 * it's requested past its deadline, but an export that's never re-fetched would
 * linger on disk forever. This runs one pass at startup and hourly thereafter.
 *
 * The deletion logic lives in the storage layer (storage/uploads.ts) and is a
 * no-op when a storage driver is registered — the fork's bucket lifecycle rules
 * own cleanup then.
 */

import { Cron } from 'croner';
import { logger } from '@greenhouse/utils/logger';
import { sweepExpiredUploads } from '../storage/uploads.js';

let sweepJob: Cron | null = null;

function runSweep(): void {
  try {
    const deleted = sweepExpiredUploads();
    if (deleted > 0) logger.info(`[UploadsSweep] 🧹 Deleted ${deleted} expired export(s)`);
  } catch (err) {
    logger.error('[UploadsSweep] ❌ Sweep failed:', err);
  }
}

/**
 * Start the hourly expired-export sweep. Runs one pass immediately so a restart
 * doesn't wait a full interval to reclaim disk. Hourly is plenty — export TTLs
 * are day-scale.
 */
export function startUploadsSweep(): void {
  runSweep();
  sweepJob = new Cron('0 * * * *', { timezone: 'UTC' }, runSweep);
  const next = sweepJob.nextRun();
  logger.info(`[UploadsSweep] 📅 Scheduled hourly expired-export sweep → next: ${next?.toISOString()}`);
}

/** Stop the sweep job (server shutdown). */
export function stopUploadsSweep(): void {
  sweepJob?.stop();
  sweepJob = null;
}
