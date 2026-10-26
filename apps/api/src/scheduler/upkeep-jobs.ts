/** System upkeep: core monthly summaries and active plugins' periodic jobs. */

import { runExtensionJob } from './extension-job.js';
import { Cron } from 'croner';
import { logger } from '@greenhouse/utils/logger';
import { extensionJobs } from '../extensions/boot.js';
import { DEFAULT_TIMEZONE } from './task-limits.js';

let extensionJobHandles: Cron[] = [];

/** Periodic jobs declared by active extensions (see extensions/define.ts → `jobs`). */
export function startExtensionJobs(): void {
  for (const job of extensionJobs()) {
    const handle = new Cron(job.cron, { timezone: job.timezone ?? DEFAULT_TIMEZONE, protect: true }, async () => {
      try {
        await runExtensionJob(job.id, job.run);
      } catch (err) {
        logger.error(`[ExtensionJob:${job.id}] Failed:`, err);
      }
    });
    extensionJobHandles.push(handle);
    logger.info(`[ExtensionJob:${job.id}] Scheduled "${job.cron}" → next: ${handle.nextRun()?.toISOString()}`);
  }
}

export function stopUpkeepJobs(): void {
  for (const handle of extensionJobHandles) handle.stop();
  extensionJobHandles = [];
}
