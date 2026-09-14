/**
 * Task Scheduler — manages cron jobs for scheduled tasks.
 *
 * Lifecycle:
 * 1. start() → load all enabled tasks from DB → create cron jobs
 * 2. Cron fires → persist one immutable Automation Runtime run
 * 3. Runtime worker claims it → creates/repairs the session → runs agent
 * 3. CRUD API → dynamically add/remove/update jobs via reload()
 * 4. stop() → cleanup all cron jobs on server shutdown
 *
 * Uses `croner` for in-process cron scheduling with timezone support.
 * On boot, a due task catches up only the latest occurrence within 24 hours.
 */

import { Cron } from 'croner';
import { getDb, RuntimeKernelError } from '@greenhouse/db';
import { recordFailedTaskSession, resolveTaskOwnerState } from './executor.js';
import { buildTaskSessionTitle } from './prompt-builder.js';
import { notifyTaskResult } from './notify.js';
import { cancelAutomationRunsForUser, enqueueAutomationRun, type AutomationTrigger } from './runtime-driver.js';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import {
  startFrictionMiningJob,
  startMemoryConsolidationJob,
  stopUpkeepJobs,
  startExtensionJobs,
} from './upkeep-jobs.js';
import type { ToolRegistry } from '../agent.js';
import type { ScheduledTaskRow } from '@greenhouse/db';

export class TaskScheduler {
  private jobs = new Map<number, Cron>();
  private readonly runtimeEnabled: boolean;

  constructor(_toolRegistry: ToolRegistry, options: { runtimeEnabled?: boolean } = {}) {
    this.runtimeEnabled = options.runtimeEnabled ?? true;
  }

  /**
   * Start the scheduler — load all enabled tasks and create cron jobs.
   */
  async start(): Promise<void> {
    const db = getDb();
    const tasks = await db.scheduledTasks.listEnabled();

    logger.info(`[Scheduler] Starting with ${tasks.length} enabled task(s)`);

    const scheduledTasks: ScheduledTaskRow[] = [];
    for (const task of tasks) {
      const ownerState = await resolveTaskOwnerState(task, db);
      if (ownerState.state === 'paused') {
        logger.info(`[Scheduler] Task id=${task.id} is paused while its owner sets a password`);
        continue;
      }
      if (ownerState.state === 'invalid') {
        await db.scheduledTasks.update(task.id, { enabled: false });
        logger.warn(`[Scheduler] Task id=${task.id} has no active internal owner; disabled`);
        continue;
      }
      if (this.runtimeEnabled) {
        await this.catchUpTask(task);
        this.scheduleTask(task);
      }
      scheduledTasks.push(task);
    }

    // Establish a future cursor for tasks that had no stored schedule cursor.
    for (const task of scheduledTasks) {
      if (task.next_run_at && Date.parse(task.next_run_at) <= Date.now()) continue;
      const nextRunAt = this.getNextRun(task);
      if (nextRunAt) {
        await db.scheduledTasks.updateNextRunAt(task.id, nextRunAt);
      }
    }

    if (!this.runtimeEnabled && scheduledTasks.length > 0) {
      logger.warn('[Scheduler] Automation Runtime worker is disabled; user cron/manual execution is unavailable');
    }

    // System-level jobs
    startFrictionMiningJob();
    startMemoryConsolidationJob();
    startExtensionJobs();
  }

  /**
   * Schedule a single task as a cron job.
   */
  private scheduleTask(task: ScheduledTaskRow): void {
    // Remove existing job if any
    this.removeJob(task.id);

    try {
      const job = new Cron(task.schedule, { timezone: task.timezone }, async () => {
        const scheduledFor = this.getLatestOccurrence(task) ?? new Date();
        await this.runTask(task.id, 'cron', scheduledFor);
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
   * Persist a concrete cron/catch-up occurrence. Runtime's database fence is
   * the overlap guard; process-local state is never authoritative.
   */
  async runTask(
    taskId: number,
    trigger: Extract<AutomationTrigger, 'cron' | 'catchup'> = 'cron',
    scheduledFor: string | Date = new Date(),
  ): Promise<string | null> {
    if (!this.runtimeEnabled) return null;
    try {
      const db = getDb();
      const task = await db.scheduledTasks.getById(taskId);
      if (!task) {
        this.removeJob(taskId);
        logger.warn(`[Scheduler] Task id=${taskId} not found`);
        return null;
      }
      // A callback already queued when the task was disabled must not run once more.
      if (!task.enabled) {
        this.removeJob(taskId);
        return null;
      }
      const ownerState = await resolveTaskOwnerState(task, db);
      if (ownerState.state !== 'active') {
        this.removeJob(taskId);
        if (ownerState.state === 'invalid') {
          await db.scheduledTasks.update(taskId, { enabled: false });
          logger.warn(`[Scheduler] Task id=${taskId} has no valid internal owner; disabled`);
        } else {
          logger.info(`[Scheduler] Task id=${taskId} paused while its owner sets a password`);
        }
        return null;
      }
      const queued = await enqueueAutomationRun({ db, task, trigger, scheduledFor });
      const nextRunAt = this.getNextRun(task);
      if (queued.run.status === 'queued') {
        await db.scheduledTasks.updateRunStatus(task.id, 'queued', nextRunAt);
      } else {
        // An exact planned occurrence may already be claimed/running/terminal
        // after a crash before next_run_at advanced. Preserve its domain state
        // and count while moving only the cron cursor.
        await db.scheduledTasks.updateNextRunAt(task.id, nextRunAt);
      }
      logger.info(`[Scheduler] Persisted Automation "${task.name}" (run=${queued.run.id})`);
      return queued.session_id;
    } catch (error) {
      if (error instanceof RuntimeKernelError && error.code === 'runtime_invalid_transition') {
        logger.warn(`[Scheduler] ⏭ Task id=${taskId} already has an active Runtime run`);
        return null;
      }
      logger.error(`[Scheduler] Failed to queue task id=${taskId}: ${toErrorMessage(error)}`);
      await this.surfaceEnqueueFailure(taskId, toErrorMessage(error));
      return null;
    }
  }

  /**
   * An enqueue failure (a removed profile, an owner deleted mid-flight, a DB
   * hiccup) used to leave only a stderr line: no session, no delivery, and a
   * task row frozen on its last real run — a broken task failed silently
   * forever. ("每日工单分析" did exactly that for two nights after its profile
   * was deleted, 2026-08-14.) Surface it the same way an execution failure is
   * surfaced: a task session holding the error, `failed` on the row with the
   * cursor advanced, and the owner's configured deliveries.
   */
  private async surfaceEnqueueFailure(taskId: number, errorMessage: string): Promise<void> {
    try {
      const db = getDb();
      const task = await db.scheduledTasks.getById(taskId);
      if (!task) return;
      const session = await db.sessions.create(
        buildTaskSessionTitle(task.name, task.timezone, new Date()),
        task.profile_id,
        task.user_id,
        undefined,
        'task',
        undefined,
        { metadata: JSON.stringify({ task_id: task.id, task_name: task.name }) },
      );
      await recordFailedTaskSession(session.id, errorMessage, false, db);
      await db.scheduledTasks.updateRunStatus(task.id, 'failed', this.getNextRun(task));
      await notifyTaskResult(db, task, { status: 'failed', summary: errorMessage, sessionId: session.id });
    } catch (surfaceError) {
      logger.error(
        `[Scheduler] Failed to surface enqueue failure for task id=${taskId}: ${toErrorMessage(surfaceError)}`,
      );
    }
  }

  /**
   * Persist a manual occurrence and return its deterministic visible session.
   */
  async runTaskManually(taskId: number, initiatedByUserId?: string): Promise<string | null> {
    if (!this.runtimeEnabled) return null;
    try {
      const db = getDb();
      const task = await db.scheduledTasks.getById(taskId);
      if (!task) {
        logger.warn(`[Scheduler] Task id=${taskId} not found`);
        return null;
      }
      const ownerState = await resolveTaskOwnerState(task, db);
      if (ownerState.state !== 'active') {
        this.removeJob(taskId);
        if (ownerState.state === 'invalid') {
          await db.scheduledTasks.update(taskId, { enabled: false });
          logger.warn(`[Scheduler] Task id=${taskId} has no valid internal owner; disabled`);
        } else {
          logger.info(`[Scheduler] Task id=${taskId} paused while its owner sets a password`);
        }
        return null;
      }

      const queued = await enqueueAutomationRun({
        db,
        task,
        trigger: 'manual',
        scheduledFor: new Date(),
        initiatedByUserId,
      });
      await db.scheduledTasks.updateRunStatus(task.id, 'queued', this.getNextRun(task));
      return queued.session_id;
    } catch (error) {
      if (error instanceof RuntimeKernelError && error.code === 'runtime_invalid_transition') {
        logger.warn(`[Scheduler] ⏭ Task id=${taskId} already has an active Runtime run`);
        return null;
      }
      logger.error(`[Scheduler] Failed to queue manual task id=${taskId}: ${toErrorMessage(error)}`);
      return null;
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

    const ownerState = await resolveTaskOwnerState(task, db);
    if (ownerState.state !== 'active') {
      this.removeJob(taskId);
      if (ownerState.state === 'invalid') {
        await db.scheduledTasks.update(taskId, { enabled: false });
        logger.warn(`[Scheduler] Task id=${taskId} has no valid internal owner; disabled`);
      } else {
        logger.info(`[Scheduler] Task id=${taskId} paused while its owner sets a password`);
      }
      return;
    }

    if (!this.runtimeEnabled) return;
    this.scheduleTask(task);

    // Update next_run_at
    const nextRunAt = this.getNextRun(task);
    if (nextRunAt) {
      await db.scheduledTasks.updateNextRunAt(task.id, nextRunAt);
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

  /** Remove cron registrations without mutating the user's enabled settings. */
  async pauseUser(userId: string): Promise<number> {
    const db = getDb();
    const tasks = await db.scheduledTasks.list(userId);
    for (const task of tasks) {
      this.removeJob(task.id);
    }
    await cancelAutomationRunsForUser(db, userId);
    return tasks.length;
  }

  /** Restore enabled cron registrations after account activation. */
  async resumeUser(userId: string): Promise<number> {
    const tasks = await getDb().scheduledTasks.list(userId);
    const enabled = tasks.filter((task) => task.enabled);
    for (const task of enabled) await this.reloadTask(task.id);
    return enabled.length;
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

  private getLatestOccurrence(task: ScheduledTaskRow, reference = new Date()): Date | null {
    try {
      const job = new Cron(task.schedule, { timezone: task.timezone });
      return job.previousRuns(1, new Date(reference.getTime() + 1_000))[0] ?? null;
    } catch {
      return null;
    }
  }

  private async catchUpTask(task: ScheduledTaskRow): Promise<void> {
    if (!task.next_run_at || Date.parse(task.next_run_at) > Date.now()) return;
    const db = getDb();
    const latest = this.getLatestOccurrence(task);
    const nextRunAt = this.getNextRun(task);
    if (!latest) {
      await db.scheduledTasks.updateRunStatus(task.id, 'missed', nextRunAt);
      return;
    }
    const ageMs = Date.now() - latest.getTime();
    if (ageMs <= 24 * 60 * 60 * 1_000) {
      const sessionId = await this.runTask(task.id, 'catchup', latest);
      if (!sessionId) await db.scheduledTasks.updateNextRunAt(task.id, nextRunAt);
      return;
    }
    await db.scheduledTasks.updateRunStatus(task.id, 'missed', nextRunAt);
    logger.warn(`[Scheduler] Task id=${task.id} missed its latest occurrence outside the 24h catch-up window`);
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
    stopUpkeepJobs();
  }

  /**
   * Get scheduler status for health checks.
   */
  getStatus(): { activeJobs: number; runningTasks: number[] } {
    return {
      activeJobs: this.jobs.size,
      // Runtime is the authoritative source; health must not pretend an
      // in-process Set knows which distributed worker owns an execution.
      runningTasks: [],
    };
  }
}

// ─── Singleton ───────────────────────────────────────────

let _scheduler: TaskScheduler | null = null;

export function initScheduler(toolRegistry: ToolRegistry, options: { runtimeEnabled?: boolean } = {}): TaskScheduler {
  if (_scheduler) {
    _scheduler.stop();
  }
  _scheduler = new TaskScheduler(toolRegistry, options);
  return _scheduler;
}

export function getScheduler(): TaskScheduler | null {
  return _scheduler;
}
