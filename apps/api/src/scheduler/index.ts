/**
 * Task Scheduler — manages cron jobs for scheduled tasks.
 *
 * Lifecycle:
 * 1. start() → load all enabled tasks from DB → create cron jobs
 * 2. Cron fires → executeTask() creates a new session with results
 * 3. CRUD API → dynamically add/remove/update jobs via reload()
 * 4. stop() → cleanup all cron jobs on server shutdown
 *
 * Uses `croner` for in-process cron scheduling with timezone support.
 * No catch-up execution — missed runs are skipped. Manual trigger available.
 */

import { Cron } from 'croner';
import { getDb } from '@greenhouse/db';
import { executeTask, executeTaskInSession } from './executor.js';
import { logger } from '@greenhouse/utils/logger';
import { startMemoryJob, stopMemoryJob } from './memory-job.js';
import type { ToolRegistry } from '../agent.js';
import type { ScheduledTaskRow } from '@greenhouse/db';

export class TaskScheduler {
  private jobs = new Map<number, Cron>();
  private toolRegistry: ToolRegistry;
  private running = new Set<number>(); // track running tasks to prevent overlap

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  /**
   * Start the scheduler — load all enabled tasks and create cron jobs.
   */
  async start(): Promise<void> {
    const db = getDb();
    const tasks = await db.scheduledTasks.listEnabled();

    logger.info(`[Scheduler] Starting with ${tasks.length} enabled task(s)`);

    for (const task of tasks) {
      this.scheduleTask(task);
    }

    // Update next_run_at for all tasks (no catch-up)
    for (const task of tasks) {
      const nextRunAt = this.getNextRun(task);
      if (nextRunAt) {
        await db.scheduledTasks.updateRunStatus(task.id, task.last_status ?? 'idle', nextRunAt);
      }
    }

    // System-level jobs
    startMemoryJob();
  }

  /**
   * Schedule a single task as a cron job.
   */
  private scheduleTask(task: ScheduledTaskRow): void {
    // Remove existing job if any
    this.removeJob(task.id);

    try {
      const job = new Cron(task.schedule, { timezone: task.timezone }, async () => {
        await this.runTask(task.id);
      });

      this.jobs.set(task.id, job);
      const next = job.nextRun();
      logger.info(
        `[Scheduler] 📅 Scheduled "${task.name}" (id=${task.id}): ${task.schedule} ` +
          `(${task.timezone}) → next: ${next?.toISOString() ?? 'none'}`,
      );
    } catch (err) {
      logger.error(
        `[Scheduler] ❌ Failed to schedule "${task.name}" (id=${task.id}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Execute a task (called by cron or manual trigger).
   * Prevents overlapping execution of the same task.
   */
  async runTask(taskId: number): Promise<string | null> {
    // Prevent overlap
    if (this.running.has(taskId)) {
      logger.warn(`[Scheduler] ⏭ Task id=${taskId} already running, skipping`);
      return null;
    }

    const db = getDb();
    const task = await db.scheduledTasks.getById(taskId);
    if (!task) {
      logger.warn(`[Scheduler] Task id=${taskId} not found`);
      return null;
    }

    this.running.add(taskId);
    try {
      return await executeTask(task, this.toolRegistry);
    } finally {
      this.running.delete(taskId);
    }
  }

  /**
   * Execute a task with a pre-created session (for manual trigger).
   * The session is already created and visible to the user.
   */
  async runTaskInSession(taskId: number, sessionId: string): Promise<void> {
    if (this.running.has(taskId)) {
      logger.warn(`[Scheduler] ⏭ Task id=${taskId} already running, skipping`);
      return;
    }

    const db = getDb();
    const task = await db.scheduledTasks.getById(taskId);
    if (!task) {
      logger.warn(`[Scheduler] Task id=${taskId} not found`);
      return;
    }

    this.running.add(taskId);
    try {
      await db.scheduledTasks.updateRunStatus(task.id, 'running');
      await executeTaskInSession(task, sessionId, this.toolRegistry);
    } catch (_err) {
      // Error handling already done inside executeTaskInSession
    } finally {
      this.running.delete(taskId);
    }
  }

  /**
   * Reload a specific task (after CRUD update).
   */
  async reloadTask(taskId: number): Promise<void> {
    const db = getDb();
    const task = await db.scheduledTasks.getById(taskId);

    if (!task || !task.enabled) {
      // Task deleted or disabled — remove job
      this.removeJob(taskId);
      return;
    }

    // Re-schedule
    this.scheduleTask(task);

    // Update next_run_at
    const nextRunAt = this.getNextRun(task);
    if (nextRunAt) {
      await db.scheduledTasks.updateRunStatus(task.id, task.last_status ?? 'idle', nextRunAt);
    }
  }

  /**
   * Remove a cron job by task ID.
   * Public — called by delete handler after DB removal.
   */
  removeJob(taskId: number): void {
    const existing = this.jobs.get(taskId);
    if (existing) {
      existing.stop();
      this.jobs.delete(taskId);
      logger.info(`[Scheduler] Removed job for task id=${taskId}`);
    }
  }

  /**
   * Get the next run time for a task.
   */
  private getNextRun(task: ScheduledTaskRow): string | null {
    try {
      const job = new Cron(task.schedule, { timezone: task.timezone });
      const next = job.nextRun();
      return next ? next.toISOString() : null;
    } catch {
      return null;
    }
  }

  /**
   * Stop all cron jobs (server shutdown).
   */
  stop(): void {
    logger.info(`[Scheduler] Stopping ${this.jobs.size} job(s)`);
    for (const [, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
    stopMemoryJob();
  }

  /**
   * Get scheduler status for health checks.
   */
  getStatus(): { activeJobs: number; runningTasks: number[] } {
    return {
      activeJobs: this.jobs.size,
      runningTasks: [...this.running],
    };
  }
}

// ─── Singleton ───────────────────────────────────────────

let _scheduler: TaskScheduler | null = null;

export function initScheduler(toolRegistry: ToolRegistry): TaskScheduler {
  if (_scheduler) {
    _scheduler.stop();
  }
  _scheduler = new TaskScheduler(toolRegistry);
  return _scheduler;
}

export function getScheduler(): TaskScheduler | null {
  return _scheduler;
}
