import { Cron } from 'croner';
import { logger, runExtensionJob } from '@greenhouse/api/extension-kit';
import { planMonthlyRetro } from './schedule.js';
let retroJob: Cron | null = null;
/**
 * (Re)schedule the monthly retro: 09:00 on the 1st in the workspace zone, or
 * once the UTC month has closed if that is later (retro/schedule.ts). One run
 * at a time; each run plans the next. Called at boot and whenever an admin
 * changes the zone. Never throws: a retro that cannot be scheduled must not
 * keep the API from starting.
 */
export async function startMonthlyRetroJob(now: Date = new Date()): Promise<Cron | null> {
  try {
    const { workspaceTimeZone } = await import('@greenhouse/api/extension-kit');
    const timeZone = await workspaceTimeZone();
    const plan = planMonthlyRetro(now, timeZone);
    retroJob?.stop();
    const job: Cron = new Cron(plan.runAt, async () => {
      try {
        const { generateMonthlyRetro } = await import('./generate.js');
        const { getDb } = await import('@greenhouse/api/extension-kit');
        await runExtensionJob(
          'retro',
          async () => {
            await generateMonthlyRetro({ db: getDb(), month: plan.month });
          },
          plan.runAt,
        );
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

export function stopMonthlyRetroJob() {
  retroJob?.stop();
  retroJob = null;
}

export { MONTHLY_RETRO_CRON } from './schedule.js';
