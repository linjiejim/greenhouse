/**
 * Upkeep jobs — system-level crons that maintain agent memory and collect
 * tool frictions. Not rows in `scheduled_tasks`; these belong to the platform.
 *
 * Replaces v1's daily memory-extraction cron (deleted): memories are now written
 * explicitly by the `memory` tool, so the background pass only tidies what is
 * already there and never invents anything.
 *
 * - 04:00 CST daily  — mine tool errors out of message pipelines into frictions
 * - 05:00 CST Sunday — memory consolidation: demote stale, merge duplicates
 * - hourly           — expire Tables form uploads nobody submitted (24 h TTL)
 * - every 15 minutes — delete Tables imports past their expiry (staged rows run to megabytes)
 * - every minute     — Tables automations sweep: enqueue due schedule / date
 *                      rules (off with `TABLES_AUTOMATION_WORKER`)
 */

import { Cron } from 'croner';
import { logger } from '@greenhouse/utils/logger';
import { extensionJobs } from '../extensions/boot.js';
import { tablesAutomationWorkerEnabled } from '../platform/tables/automation-config.js';
import { DEFAULT_TIMEZONE } from './task-limits.js';

let frictionJob: Cron | null = null;
let consolidationJob: Cron | null = null;
let tablesFormUploadJob: Cron | null = null;
let tablesImportSweepJob: Cron | null = null;
let tablesAutomationSweepJob: Cron | null = null;
let extensionJobHandles: Cron[] = [];

export function startFrictionMiningJob(): void {
  frictionJob = new Cron('0 4 * * *', { timezone: 'Asia/Shanghai' }, async () => {
    logger.info('[FrictionJob] Mining tool errors from recent pipelines...');
    try {
      const { mineToolErrors, mineEmptySearches } = await import('../frictions/friction-center.js');
      const { getDb } = await import('@greenhouse/db');
      const db = getDb();
      const errors = await mineToolErrors(db);
      // Retrieval that succeeded and found nothing — the same sweep, a
      // different failure shape (see mineEmptySearches).
      const empty = await mineEmptySearches(db);
      logger.info('[FrictionJob] Completed', { errors, empty });
    } catch (err) {
      logger.error('[FrictionJob] Failed:', err);
    }
  });

  logger.info(`[FrictionJob] Scheduled daily friction mining → next: ${frictionJob.nextRun()?.toISOString()}`);
}

export function startMemoryConsolidationJob(): void {
  consolidationJob = new Cron('0 5 * * 0', { timezone: 'Asia/Shanghai' }, async () => {
    logger.info('[MemoryUpkeep] Starting weekly memory consolidation...');
    try {
      const { runMemoryConsolidation } = await import('../llm/memory.js');
      const result = await runMemoryConsolidation();
      logger.info('[MemoryUpkeep] Completed', result);
    } catch (err) {
      logger.error('[MemoryUpkeep] Failed:', err);
    }
  });

  logger.info(
    `[MemoryUpkeep] Scheduled weekly memory consolidation → next: ${consolidationJob.nextRun()?.toISOString()}`,
  );
}

/**
 * Files a form's audience staged through `POST /api/forms/:id/uploads` but never
 * submitted (spec 20261011-tables-foundation §3), and files an app's audience
 * staged through `POST /api/apps/:id/uploads` but never attached (apps spec §3):
 * expire them and delete the objects once they are older than 24 h.
 */
export function startTablesFormUploadSweepJob(): void {
  tablesFormUploadJob = new Cron('23 * * * *', { timezone: DEFAULT_TIMEZONE }, async () => {
    try {
      const { sweepStaleFormUploads } = await import('../platform/tables/form-uploads.js');
      const { sweepStaleAppUploads } = await import('../platform/tables/app-uploads.js');
      const { getDb } = await import('@greenhouse/db');
      const expired = await sweepStaleFormUploads(getDb());
      if (expired > 0) logger.info('[TablesFormUploads] Expired unsubmitted form uploads', { expired });
      const expiredApp = await sweepStaleAppUploads(getDb());
      if (expiredApp > 0) logger.info('[TablesFormUploads] Expired unattached app uploads', { expired: expiredApp });
    } catch (err) {
      logger.error('[TablesFormUploads] Sweep failed:', err);
    }
  });
  logger.info(`[TablesFormUploads] Scheduled hourly sweep → next: ${tablesFormUploadJob.nextRun()?.toISOString()}`);
}

/** Tables imports past their expiry: staged rows run to megabytes (spec 20261011-tables-foundation §6). */
export function startTablesImportSweepJob(): void {
  tablesImportSweepJob = new Cron('*/15 * * * *', { timezone: DEFAULT_TIMEZONE }, async () => {
    try {
      const { getDb } = await import('@greenhouse/db');
      const removed = await getDb().tables.sweepExpiredImports();
      if (removed > 0) logger.info('[TablesImportSweep] Removed expired imports', { removed });
    } catch (err) {
      logger.error('[TablesImportSweep] Failed:', err);
    }
  });
}

/**
 * Tables automations: schedule and date-reached rules are enqueued by this
 * sweep (`platform/tables/automation-sweep.ts`) and run by the automation
 * worker. Overlapping passes are skipped (`protect`); enqueues are idempotent.
 */
export function startTablesAutomationSweep(): void {
  if (!tablesAutomationWorkerEnabled()) {
    logger.info('[TablesAutomationSweep] Off (TABLES_AUTOMATION_WORKER)');
    return;
  }
  tablesAutomationSweepJob = new Cron('* * * * *', { protect: true }, async () => {
    try {
      const { sweepTablesAutomations } = await import('../platform/tables/automation-sweep.js');
      const { getDb } = await import('@greenhouse/db');
      const result = await sweepTablesAutomations(getDb());
      if (result.enqueued > 0) logger.info('[TablesAutomationSweep] Enqueued', { ...result });
    } catch (err) {
      logger.error('[TablesAutomationSweep] Failed:', err);
    }
  });
}

/** Periodic jobs declared by active extensions (see extensions/define.ts → `jobs`). */
export function startExtensionJobs(): void {
  for (const job of extensionJobs()) {
    const handle = new Cron(job.cron, { timezone: job.timezone ?? DEFAULT_TIMEZONE }, async () => {
      try {
        await job.run();
      } catch (err) {
        logger.error(`[ExtensionJob:${job.id}] Failed:`, err);
      }
    });
    extensionJobHandles.push(handle);
    logger.info(`[ExtensionJob:${job.id}] Scheduled "${job.cron}" → next: ${handle.nextRun()?.toISOString()}`);
  }
}

export function stopUpkeepJobs(): void {
  frictionJob?.stop();
  frictionJob = null;
  consolidationJob?.stop();
  consolidationJob = null;
  tablesFormUploadJob?.stop();
  tablesFormUploadJob = null;
  tablesImportSweepJob?.stop();
  tablesImportSweepJob = null;
  tablesAutomationSweepJob?.stop();
  tablesAutomationSweepJob = null;
  for (const handle of extensionJobHandles) handle.stop();
  extensionJobHandles = [];
}
