/**
 * Upkeep jobs — system-level crons that maintain agent memory and collect
 * tool frictions. Not rows in `automations`; these belong to the platform.
 *
 * Replaces v1's daily memory-extraction cron (deleted): memories are now written
 * explicitly by the `memory` tool, so the background pass only tidies what is
 * already there and never invents anything.
 *
 * - 04:00 CST daily  — mine tool errors out of message pipelines into frictions
 * - 05:00 CST Sunday — memory consolidation: demote stale, merge duplicates
 * - 09:00 on the 1st, workspace time (never before the UTC month has closed) —
 *   the monthly retro of the month that ended (retro/schedule.ts + generate.ts;
 *   the zone is `team_context.timezone`, rescheduled on change)
 */

import { Cron } from 'croner';
import { logger } from '@greenhouse/utils/logger';
import { extensionJobs } from '../extensions/boot.js';
import { DEFAULT_TIMEZONE } from './task-limits.js';
import { planMonthlyRetro } from '../retro/schedule.js';

let frictionJob: Cron | null = null;
let retroJob: Cron | null = null;
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

export { MONTHLY_RETRO_CRON } from '../retro/schedule.js';

/**
 * (Re)schedule the monthly retro: 09:00 on the 1st in the workspace zone, or
 * once the UTC month has closed if that is later (retro/schedule.ts). One run
 * at a time; each run plans the next. Called at boot and whenever an admin
 * changes the zone. Never throws: a retro that cannot be scheduled must not
 * keep the API from starting.
 */
export async function startMonthlyRetroJob(now: Date = new Date()): Promise<Cron | null> {
  try {
    const { workspaceTimeZone } = await import('../hub-context/settings.js');
    const timeZone = await workspaceTimeZone();
    const plan = planMonthlyRetro(now, timeZone);
    retroJob?.stop();
    const job: Cron = new Cron(plan.runAt, async () => {
      try {
        const { generateMonthlyRetro } = await import('../retro/generate.js');
        const { getDb } = await import('@greenhouse/db');
        await generateMonthlyRetro({ db: getDb(), month: plan.month });
      } catch (err) {
        logger.error('[RetroJob] Failed:', err);
      } finally {
        // Plan the next month unless something rescheduled us meanwhile.
        if (retroJob === job) await startMonthlyRetroJob(new Date(Math.max(Date.now(), plan.runAt.getTime() + 1)));
      }
    });
    retroJob = job;
    logger.info(`[RetroJob] Scheduled the ${plan.month} retro (${timeZone}) → ${plan.runAt.toISOString()}`);
    return job;
  } catch (err) {
    logger.error('[RetroJob] Could not schedule the monthly retro:', err);
    return null;
  }
}

/** When the monthly retro runs next, or null when it is not scheduled. */
export function monthlyRetroNextRun(): Date | null {
  return retroJob?.nextRun() ?? null;
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
  retroJob?.stop();
  retroJob = null;
  consolidationJob?.stop();
  consolidationJob = null;
  for (const handle of extensionJobHandles) handle.stop();
  extensionJobHandles = [];
}
