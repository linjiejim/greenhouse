/**
 * Scheduled Tasks routes — /api/tasks
 *
 * CRUD for scheduled tasks + manual trigger + execution history.
 *
 * Permission: internal+ (member, admin, super).
 * Members can only use profiles assigned to them.
 * Admin/super can use any profile.
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { Cron } from 'croner';
import { getScheduler } from '../scheduler/index.js';
import { resolveProfile } from '../profile.js';
import { sanitizeForPrompt } from '../security.js';
import { logger } from '@greenhouse/utils/logger';
import type { AuthUser } from '../auth/token.js';
import type { ToolRegistry } from '../agent.js';
import type { AppEnv } from '../app-env.js';

// ─── Constants ───────────────────────────────────────────

const MAX_TASKS_PER_USER = 10;
const MAX_PROMPT_LENGTH = 4000;
const MIN_PROMPT_LENGTH = 10;
const MAX_STEPS_LIMIT = 20;

// ─── Validation ──────────────────────────────────────────

function validateCron(expr: string): { valid: boolean; error?: string } {
  if (expr.length > 100) return { valid: false, error: 'Cron expression too long' };
  try {
    const job = new Cron(expr);
    // Check minimum interval (1 hour)
    const next1 = job.nextRun();
    if (!next1) return { valid: false, error: 'Cron expression has no next run' };
    const next2 = job.nextRuns(2);
    if (next2.length >= 2) {
      const intervalMs = next2[1].getTime() - next2[0].getTime();
      if (intervalMs < 3600_000) {
        return { valid: false, error: 'Minimum interval is 1 hour' };
      }
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Invalid cron expression: ${err instanceof Error ? err.message : err}` };
  }
}

function validateTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Team members may only use profiles assigned to them (or public ones).
 * Returns an error message, or null when access is allowed.
 * Shared by POST / (create) and PUT /:id (profile_id change) — keep in sync.
 */
async function checkProfileAccess(user: AuthUser, profileId: string): Promise<string | null> {
  if (user.role !== 'team') return null;
  const hasAccess = await getDb().userProfiles.hasProfile(user.id, profileId);
  const profile = resolveProfile(profileId);
  if (!hasAccess && profile.access.level !== 'public') {
    return `Profile "${profileId}" is not assigned to your account`;
  }
  return null;
}

/**
 * Get a human-readable description of a cron schedule.
 */
function describeCron(expr: string, timezone: string): string {
  try {
    const job = new Cron(expr, { timezone });
    const next = job.nextRun();
    return next ? `Next: ${next.toISOString()}` : 'No next run';
  } catch {
    return expr;
  }
}

// ─── Route Factory ───────────────────────────────────────

export function createTasksRoute(_toolRegistry: ToolRegistry) {
  return (
    new Hono<AppEnv>()
      /**
       * GET /api/tasks — List my scheduled tasks.
       */
      .get('/', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const db = getDb();
        let taskList;

        if (user.role === 'super') {
          // Only super sees all tasks (task prompts can carry sensitive context;
          // every other endpoint in this file is owner-or-super too)
          taskList = await db.scheduledTasks.list();
        } else {
          // Members see only their own tasks
          taskList = await db.scheduledTasks.list(user.id);
        }

        return c.json({
          tasks: taskList.map((t) => ({
            ...t,
            schedule_desc: describeCron(t.schedule, t.timezone),
          })),
        });
      })
      /**
       * POST /api/tasks — Create a scheduled task.
       */
      .post('/', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const body = await c.req.json();
        const { name, profile_id, task_prompt, schedule, timezone, max_steps, enabled } = body as {
          name?: string;
          profile_id?: string;
          task_prompt?: string;
          schedule?: string;
          timezone?: string;
          max_steps?: number;
          enabled?: boolean;
        };

        // ── Validation ──

        if (!name || name.length < 2 || name.length > 50) {
          return c.json({ error: 'Name must be 2-50 characters' }, 400);
        }

        if (!task_prompt || task_prompt.length < MIN_PROMPT_LENGTH || task_prompt.length > MAX_PROMPT_LENGTH) {
          return c.json({ error: `Task prompt must be ${MIN_PROMPT_LENGTH}-${MAX_PROMPT_LENGTH} characters` }, 400);
        }

        if (!schedule) {
          return c.json({ error: 'Schedule (cron expression) is required' }, 400);
        }

        const cronCheck = validateCron(schedule);
        if (!cronCheck.valid) {
          return c.json({ error: cronCheck.error }, 400);
        }

        const tz = timezone ?? 'UTC';
        if (!validateTimezone(tz)) {
          return c.json({ error: `Invalid timezone: ${tz}` }, 400);
        }

        if (max_steps !== undefined && (max_steps < 1 || max_steps > MAX_STEPS_LIMIT)) {
          return c.json({ error: `max_steps must be 1-${MAX_STEPS_LIMIT}` }, 400);
        }

        // Validate profile access
        const profileId = profile_id ?? 'default';
        try {
          resolveProfile(profileId);
        } catch {
          return c.json({ error: `Profile "${profileId}" not found` }, 400);
        }

        const accessError = await checkProfileAccess(user, profileId);
        if (accessError) {
          return c.json({ error: accessError }, 403);
        }

        // Check user limit
        const db = getDb();
        const count = await db.scheduledTasks.countByUser(user.id);
        if (count >= MAX_TASKS_PER_USER) {
          return c.json({ error: `Maximum ${MAX_TASKS_PER_USER} tasks per user` }, 400);
        }

        // ── Create ──

        const sanitizedPrompt = sanitizeForPrompt(task_prompt);
        const task = await db.scheduledTasks.create({
          user_id: user.id,
          name,
          profile_id: profileId,
          task_prompt: sanitizedPrompt,
          schedule,
          timezone: tz,
          max_steps: max_steps ?? 15,
          enabled: enabled ?? true,
        });

        // Schedule the cron job
        const scheduler = getScheduler();
        if (scheduler && task.enabled) {
          await scheduler.reloadTask(task.id);
        }

        logger.info(`[Tasks] Created task "${name}" (id=${task.id}) by ${user.id}`);

        return c.json(
          {
            task: { ...task, schedule_desc: describeCron(task.schedule, task.timezone) },
          },
          201,
        );
      })
      /**
       * GET /api/tasks/:id — Get task detail + recent execution history.
       */
      .get('/:id', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const id = parseInt(c.req.param('id'), 10);
        if (isNaN(id)) return c.json({ error: 'Invalid task ID' }, 400);

        const db = getDb();
        const task = await db.scheduledTasks.getById(id);
        if (!task) return c.json({ error: 'Task not found' }, 404);

        // Permission check
        if (task.user_id !== user.id && user.role !== 'super') {
          return c.json({ error: 'Not authorized' }, 403);
        }

        // Get recent execution sessions
        const recentSessions = await db.sessions.list({
          taskId: task.id,
          limit: 10,
        });

        const recentRuns = recentSessions.map((s) => ({
          session_id: s.id,
          title: s.title,
          status: s.status,
          created_at: s.created_at,
        }));

        return c.json({
          task: { ...task, schedule_desc: describeCron(task.schedule, task.timezone) },
          recent_runs: recentRuns,
        });
      })
      /**
       * PUT /api/tasks/:id — Update a scheduled task.
       */
      .put('/:id', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const id = parseInt(c.req.param('id'), 10);
        if (isNaN(id)) return c.json({ error: 'Invalid task ID' }, 400);

        const db = getDb();
        const existing = await db.scheduledTasks.getById(id);
        if (!existing) return c.json({ error: 'Task not found' }, 404);

        if (existing.user_id !== user.id && user.role !== 'super') {
          return c.json({ error: 'Not authorized' }, 403);
        }

        const body = await c.req.json();
        const updates: Record<string, unknown> = {};

        if (body.name !== undefined) {
          if (body.name.length < 2 || body.name.length > 50) {
            return c.json({ error: 'Name must be 2-50 characters' }, 400);
          }
          updates.name = body.name;
        }

        if (body.task_prompt !== undefined) {
          if (body.task_prompt.length < MIN_PROMPT_LENGTH || body.task_prompt.length > MAX_PROMPT_LENGTH) {
            return c.json({ error: `Task prompt must be ${MIN_PROMPT_LENGTH}-${MAX_PROMPT_LENGTH} characters` }, 400);
          }
          updates.task_prompt = sanitizeForPrompt(body.task_prompt);
        }

        if (body.schedule !== undefined) {
          const cronCheck = validateCron(body.schedule);
          if (!cronCheck.valid) {
            return c.json({ error: cronCheck.error }, 400);
          }
          updates.schedule = body.schedule;
        }

        if (body.timezone !== undefined) {
          if (!validateTimezone(body.timezone)) {
            return c.json({ error: `Invalid timezone: ${body.timezone}` }, 400);
          }
          updates.timezone = body.timezone;
        }

        if (body.max_steps !== undefined) {
          if (body.max_steps < 1 || body.max_steps > MAX_STEPS_LIMIT) {
            return c.json({ error: `max_steps must be 1-${MAX_STEPS_LIMIT}` }, 400);
          }
          updates.max_steps = body.max_steps;
        }

        if (body.profile_id !== undefined) {
          try {
            resolveProfile(body.profile_id);
          } catch {
            return c.json({ error: `Profile "${body.profile_id}" not found` }, 400);
          }
          // Same gate as POST — without this, a member could create a task on a
          // permitted profile and then switch it to an unauthorized one.
          const accessError = await checkProfileAccess(user, body.profile_id);
          if (accessError) {
            return c.json({ error: accessError }, 403);
          }
          updates.profile_id = body.profile_id;
        }

        if (body.enabled !== undefined) {
          updates.enabled = body.enabled;
        }

        const updated = await db.scheduledTasks.update(id, updates);
        if (!updated) return c.json({ error: 'Update failed' }, 500);

        // Reload scheduler
        const scheduler = getScheduler();
        if (scheduler) {
          await scheduler.reloadTask(id);
        }

        logger.info(`[Tasks] Updated task id=${id} by ${user.id}`);

        return c.json({
          task: { ...updated, schedule_desc: describeCron(updated.schedule, updated.timezone) },
        });
      })
      /**
       * DELETE /api/tasks/:id — Delete a task (keeps historical sessions).
       */
      .delete('/:id', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const id = parseInt(c.req.param('id'), 10);
        if (isNaN(id)) return c.json({ error: 'Invalid task ID' }, 400);

        const db = getDb();
        const existing = await db.scheduledTasks.getById(id);
        if (!existing) return c.json({ error: 'Task not found' }, 404);

        if (existing.user_id !== user.id && user.role !== 'super') {
          return c.json({ error: 'Not authorized' }, 403);
        }

        // Delete from DB first, then remove the in-memory cron job
        await db.scheduledTasks.delete(id);

        const scheduler = getScheduler();
        if (scheduler) {
          scheduler.removeJob(id);
        }
        logger.info(`[Tasks] Deleted task "${existing.name}" (id=${id}) by ${user.id}`);

        return c.json({ ok: true });
      })
      /**
       * POST /api/tasks/:id/run — Manually trigger a task execution.
       * Creates session immediately and returns. Agent runs in background.
       */
      .post('/:id/run', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const id = parseInt(c.req.param('id'), 10);
        if (isNaN(id)) return c.json({ error: 'Invalid task ID' }, 400);

        const db = getDb();
        const task = await db.scheduledTasks.getById(id);
        if (!task) return c.json({ error: 'Task not found' }, 404);

        if (task.user_id !== user.id && user.role !== 'super') {
          return c.json({ error: 'Not authorized' }, 403);
        }

        const scheduler = getScheduler();
        if (!scheduler) {
          return c.json({ error: 'Scheduler not initialized' }, 500);
        }

        // Check if already running
        const status = scheduler.getStatus();
        if (status.runningTasks.includes(id)) {
          return c.json({ error: 'Task is already running' }, 409);
        }

        // Prepare session immediately (create session + user message)
        const { prepareTask } = await import('../scheduler/executor.js');
        const sessionId = await prepareTask(task);

        // Mark as running
        await db.scheduledTasks.updateRunStatus(task.id, 'running');

        // Fire-and-forget: run agent in background
        scheduler.runTaskInSession(id, sessionId).catch(() => {
          // Error already logged and written to session by executor
        });

        logger.info(`[Tasks] Manual trigger task "${task.name}" (id=${id}) by ${user.id} → session=${sessionId}`);

        return c.json({
          ok: true,
          session_id: sessionId,
          message: `Task "${task.name}" started`,
        });
      })
      /**
       * GET /api/tasks/:id/history — Get execution history (sessions).
       */
      .get('/:id/history', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const id = parseInt(c.req.param('id'), 10);
        if (isNaN(id)) return c.json({ error: 'Invalid task ID' }, 400);

        const db = getDb();
        const task = await db.scheduledTasks.getById(id);
        if (!task) return c.json({ error: 'Task not found' }, 404);

        if (task.user_id !== user.id && user.role !== 'super') {
          return c.json({ error: 'Not authorized' }, 403);
        }

        const limit = parseInt(c.req.query('limit') ?? '20', 10);
        const offset = parseInt(c.req.query('offset') ?? '0', 10);

        const sessions = await db.sessions.list({
          taskId: task.id,
          limit,
          offset,
          status: 'all',
        });

        return c.json({
          task_id: task.id,
          task_name: task.name,
          runs: sessions.map((s) => ({
            session_id: s.id,
            title: s.title,
            status: s.status,
            created_at: s.created_at,
            updated_at: s.updated_at,
          })),
        });
      })
  );
}
