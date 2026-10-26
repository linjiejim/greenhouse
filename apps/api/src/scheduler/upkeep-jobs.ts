/** System upkeep: core monthly summaries and active plugins' periodic jobs. */

import { getDb } from '@greenhouse/db';
import { Cron } from 'croner';
import { logger } from '@greenhouse/utils/logger';
import { extensionJobs } from '../extensions/boot.js';
import { DEFAULT_TIMEZONE } from './task-limits.js';
import { planMonthlyRetro } from '../retro/schedule.js';

let retroJob: Cron | null = null;
let extensionJobHandles: Cron[] = [];

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
    const handle = new Cron(job.cron, { timezone: job.timezone ?? DEFAULT_TIMEZONE, protect: true }, async () => {
      try {
        const db = getDb();
        await db.withAdvisoryLock(`extension-job:${job.id}`, async () => {
          const minute = Math.floor(Date.now() / 60_000);
          const claimed = await db.rateLimits.hit(
            `extension-job:${job.id}:${minute}`,
            new Date((minute + 2) * 60_000).toISOString(),
          );
          if (claimed === 1) await job.run();
        });
      } catch (err) {
        logger.error(`[ExtensionJob:${job.id}] Failed:`, err);
      }
    });
    extensionJobHandles.push(handle);
    logger.info(`[ExtensionJob:${job.id}] Scheduled "${job.cron}" → next: ${handle.nextRun()?.toISOString()}`);
  }
}

export function stopUpkeepJobs(): void {
  retroJob?.stop();
  retroJob = null;
  for (const handle of extensionJobHandles) handle.stop();
  extensionJobHandles = [];
}
