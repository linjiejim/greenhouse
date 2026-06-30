/**
 * Memory Job — daily cron for user memory extraction.
 *
 * System-level job (not in scheduled_tasks table).
 * Runs at 03:00 CST daily, extracts memories from unprocessed sessions
 * for users who have the 'memory' feature enabled.
 */

import { Cron } from 'croner';
import { logger } from '@greenhouse/utils/logger';

let memoryJob: Cron | null = null;

/**
 * Start the daily memory extraction cron job.
 */
export function startMemoryJob(): void {
  // Run at 03:00 UTC daily
  memoryJob = new Cron('0 3 * * *', { timezone: 'UTC' }, async () => {
    logger.info('[MemoryJob] 🧠 Starting daily memory extraction...');
    try {
      const { runMemoryExtraction } = await import('../llm/memory.js');
      const result = await runMemoryExtraction();
      logger.info('[MemoryJob] ✅ Completed', result);
    } catch (err) {
      logger.error('[MemoryJob] ❌ Failed:', err);
    }
  });

  const next = memoryJob.nextRun();
  logger.info(`[MemoryJob] 📅 Scheduled daily memory extraction → next: ${next?.toISOString()}`);
}

/**
 * Stop the memory extraction cron job.
 */
export function stopMemoryJob(): void {
  memoryJob?.stop();
  memoryJob = null;
}
