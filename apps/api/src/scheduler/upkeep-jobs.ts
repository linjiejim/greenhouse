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
 */

import { Cron } from 'croner';
import { logger } from '@greenhouse/utils/logger';
import { extensionJobs } from '../extensions/boot.js';
import { DEFAULT_TIMEZONE } from './task-limits.js';

let frictionJob: Cron | null = null;
let consolidationJob: Cron | null = null;
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
  for (const handle of extensionJobHandles) handle.stop();
  extensionJobHandles = [];
}
