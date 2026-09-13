/**
 * Scheduled Task Center — ONE implementation of Automation CRUD, shared by the
 * HTTP routes (routes/tasks.ts) and the agent tools (tools/automation-*.ts).
 *
 * It owns everything a caller must not re-derive: cron/timezone validation, the
 * per-user quota, the hidden-profile gate, prompt sanitization, and the
 * in-memory scheduler coupling (reload / remove / manual trigger). Transports
 * are thin: they map results to HTTP statuses or hand the message to the model.
 *
 * Results are discriminated unions with a `code` instead of thrown errors — the
 * same shape skills/center.ts uses for the same reason.
 *
 * Scoping: `actor.scope` decides whether a super may reach other users' tasks.
 * The HTTP console passes 'any' (admin surface); agent tools pass 'own', so a
 * model can never read or edit another person's automation even for a super.
 */

import { Cron } from 'croner';
import { logger } from '@greenhouse/utils/logger';
import type { AutomationRunEntry } from '@greenhouse/types/api';
import { AUTOMATION_OPT_IN_TOOLS, isAutomationOptInTool } from '@greenhouse/types/automation-tools';
import { ScheduledTaskActiveRunError, type DatabaseProvider, type ScheduledTaskRow } from '@greenhouse/db';
import { resolveProfileAsync } from '../profile.js';
import { pinProfileIdForUser, ProfileAccessError } from '../profile-access.js';
import { sanitizeForPrompt } from '../security.js';
import { getScheduler } from './index.js';
import {
  DEFAULT_TIMEZONE,
  MAX_NAME_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_STEPS_LIMIT,
  MAX_TASKS_PER_USER,
  MIN_INTERVAL_MS,
  MIN_NAME_LENGTH,
  MIN_PROMPT_LENGTH,
} from './task-limits.js';

export * from './task-limits.js';

// ─── Result types ────────────────────────────────────────

export interface TaskActor {
  userId: string;
  role: string;
  /**
   * 'own' — only the actor's own tasks (agent tools).
   * 'any' — a super may also reach other users' tasks (HTTP admin console).
   */
  scope: 'own' | 'any';
  /**
   * May this caller set `unattended_tools`?
   *
   * True only for the HTTP console, where the request carries the user's own
   * Bearer and the value came from checkboxes they ticked. The agent tools pin
   * it to false by construction: `automation_mutation` is a builtin every chat
   * model can call, so a model able to write this column could mint an
   * automation holding `crm_mutation` off a single injected instruction, with
   * nobody ever having seen a checkbox. Model drafts, user grants — the same
   * shape as task_capture and tables_schema_plan.
   */
  canGrantTools?: boolean;
}

export type TaskErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict' | 'unavailable' | 'internal';
export type TaskError = { ok: false; code: TaskErrorCode; error: string };
const err = (code: TaskErrorCode, error: string): TaskError => ({ ok: false, code, error });

/** A task row plus the derived human-readable schedule description. */
export type ScheduledTaskView = ScheduledTaskRow & { schedule_desc: string };

export interface TaskRunSummary {
  session_id: string;
  title: string | null;
  status: string;
  created_at: string;
}

export type ListTasksResult = { ok: true; tasks: ScheduledTaskView[] } | TaskError;
export type GetTaskResult = { ok: true; task: ScheduledTaskView; recent_runs: TaskRunSummary[] } | TaskError;
export type ListTaskRunsResult = { ok: true; task: ScheduledTaskView; entries: AutomationRunEntry[] } | TaskError;
export type MutateTaskResult = { ok: true; task: ScheduledTaskView } | TaskError;
export type DeleteTaskResult = { ok: true; name: string } | TaskError;
export type RunTaskResult = { ok: true; session_id: string; name: string } | TaskError;

export interface CreateTaskInput {
  name?: string;
  profile_id?: string;
  task_prompt?: string;
  schedule?: string;
  timezone?: string;
  max_steps?: number;
  enabled?: boolean;
  /** Optional WeCom / Feishu group-bot webhook the scheduler posts a run summary to. */
  notify_webhook?: string | null;
  /**
   * Email the run summary to the OWNER's account address. A boolean, not an
   * address — the recipient is derived, so this channel cannot be aimed.
   */
  notify_email?: boolean;
  notify_wecom?: boolean;
  notify_feishu?: boolean;
  /**
   * Extra tools the owner grants to this automation's unattended runs. Only
   * accepted from an actor with `canGrantTools`; see TaskActor.
   */
  unattended_tools?: string[];
}

export type UpdateTaskInput = CreateTaskInput;

// ─── Validation ──────────────────────────────────────────

export function validateCron(expr: string): { valid: boolean; error?: string } {
  if (expr.length > 100) return { valid: false, error: 'Cron expression too long' };
  try {
    const job = new Cron(expr);
    // Check minimum interval (1 hour)
    const next1 = job.nextRun();
    if (!next1) return { valid: false, error: 'Cron expression has no next run' };
    const next2 = job.nextRuns(2);
    if (next2.length >= 2) {
      const intervalMs = next2[1]!.getTime() - next2[0]!.getTime();
      if (intervalMs < MIN_INTERVAL_MS) {
        return { valid: false, error: 'Minimum interval is 1 hour' };
      }
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, error: `Invalid cron expression: ${error instanceof Error ? error.message : error}` };
  }
}

export function validateTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Same access rule as chat: internal users may use interactive profiles, while
 * hidden integration profiles are unavailable to every interactive caller.
 * Returns an error message, or null when access is allowed.
 * Shared by create and update (profile_id change) — without the update gate a
 * member could create a task on a permitted profile and then switch it.
 */
export async function checkProfileAccess(profileId: string, database?: DatabaseProvider): Promise<string | null> {
  const profile = await resolveProfileAsync(profileId, database);
  if (profile.access.level === 'hidden') {
    return `Profile "${profileId}" is not available`;
  }
  return null;
}

/** Human-readable description of a cron schedule (next fire time). */
export function describeCron(expr: string, timezone: string): string {
  try {
    const job = new Cron(expr, { timezone });
    const next = job.nextRun();
    return next ? `Next: ${next.toISOString()}` : 'No next run';
  } catch {
    return expr;
  }
}

function toView(task: ScheduledTaskRow): ScheduledTaskView {
  return { ...task, schedule_desc: describeCron(task.schedule, task.timezone) };
}

/**
 * Delivery webhooks are pinned to the WeCom and Feishu group-bot endpoints.
 * The value is user-supplied and the scheduler POSTs the run summary to it, so
 * an open URL field would be an outbound channel aimed anywhere — that is the
 * reason delivery is a scheduler behaviour and not a tool the model can call.
 */
export function validateNotifyWebhook(raw: string | null | undefined): TaskError | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw.length > 500) return err('invalid', 'Webhook URL too long');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err('invalid', 'Webhook must be a valid URL');
  }
  if (url.protocol !== 'https:') {
    return err('invalid', 'Webhook must be an https:// URL');
  }
  // Two trusted hosts, nothing else: the whitelist is what keeps this field
  // from being a "POST anywhere" channel. Feishu bot webhooks additionally live
  // under a fixed path, so pin that too.
  const isWeCom = url.hostname === 'qyapi.weixin.qq.com';
  const isFeishu = url.hostname === 'open.feishu.cn' && url.pathname.startsWith('/open-apis/bot/');
  if (!isWeCom && !isFeishu) {
    return err(
      'invalid',
      'Webhook must be a WeCom (https://qyapi.weixin.qq.com/...) or Feishu (https://open.feishu.cn/open-apis/bot/...) group-bot URL',
    );
  }
  return null;
}

/**
 * Validate an `unattended_tools` grant and return the canonical JSON to store.
 *
 * Returns `undefined` when the caller did not supply the field at all (so
 * `update` leaves the stored grant alone), a `TaskError` when it is refused,
 * and `{ json }` otherwise.
 *
 * Unknown ids are REFUSED rather than dropped: a checkbox we silently ignored
 * is a checkbox that lies about what the automation may do. The message quotes
 * the offending id and lists what is grantable, because an error that only says
 * "invalid" leaves the caller guessing (api AGENTS, "错误文案应当指路").
 */
export function validateUnattendedTools(
  raw: string[] | undefined,
  actor: TaskActor,
): { json: string } | TaskError | undefined {
  if (raw === undefined) return undefined;
  if (!actor.canGrantTools) {
    return err(
      'forbidden',
      'unattended_tools can only be granted by the automation owner in the console (设置 → Automations → 编辑 → Tools). ' +
        'Ask the user to tick the tools there; a model cannot grant them.',
    );
  }
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
    return err('invalid', 'unattended_tools must be an array of tool ids');
  }
  const grantable = AUTOMATION_OPT_IN_TOOLS.map((t) => t.id);
  for (const id of raw) {
    if (!isAutomationOptInTool(id)) {
      return err(
        'invalid',
        `"${id}" cannot be granted to an unattended run. Grantable tools: ${grantable.join(', ')}.`,
      );
    }
  }
  // Store in catalog order with duplicates collapsed, so the value the
  // admission check compares against is canonical.
  const picked = new Set(raw);
  return { json: JSON.stringify(grantable.filter((id) => picked.has(id))) };
}

/** Owner-or-(super in 'any' scope). Agent tools stay owner-only by construction. */
function canAccess(task: ScheduledTaskRow, actor: TaskActor): boolean {
  if (task.user_id === actor.userId) return true;
  return actor.scope === 'any' && actor.role === 'super';
}

/** Resolve + validate a profile id, returning the error message on failure. */
async function resolveTaskProfile(
  rawProfileId: string | undefined,
  actor: TaskActor,
  database: DatabaseProvider,
): Promise<{ profileId: string } | TaskError> {
  try {
    if (actor.role !== 'team' && actor.role !== 'super') return err('forbidden', 'Internal account required');
    const profileId = await pinProfileIdForUser({ id: actor.userId, role: actor.role }, rawProfileId, database);
    const accessError = await checkProfileAccess(profileId, database);
    if (accessError) return err('forbidden', accessError);
    return { profileId };
  } catch (error) {
    if (error instanceof ProfileAccessError && error.status === 403) return err('forbidden', error.message);
    return err('invalid', `Profile "${rawProfileId ?? 'team'}" not found`);
  }
}

// ─── Operations ──────────────────────────────────────────

/**
 * List tasks. Scope 'any' + super sees every user's tasks (task prompts can
 * carry sensitive context, so that is deliberately the admin console only).
 */
export async function listTasks(db: DatabaseProvider, actor: TaskActor): Promise<ListTasksResult> {
  const seeAll = actor.scope === 'any' && actor.role === 'super';
  const rows = await db.scheduledTasks.list(seeAll ? undefined : actor.userId);
  return { ok: true, tasks: rows.map(toView) };
}

/** Get one task plus its recent execution sessions. */
export async function getTask(db: DatabaseProvider, actor: TaskActor, id: number): Promise<GetTaskResult> {
  if (!Number.isInteger(id)) return err('invalid', 'Invalid task ID');

  const task = await db.scheduledTasks.getById(id);
  if (!task) return err('not_found', 'Task not found');
  if (!canAccess(task, actor)) return err('forbidden', 'Not authorized');

  const recentSessions = await db.sessions.list({ taskId: task.id, limit: 10 });
  const recent_runs: TaskRunSummary[] = recentSessions.map((s) => ({
    session_id: s.id,
    title: s.title,
    status: s.status,
    created_at: s.created_at,
  }));

  return { ok: true, task: toView(task), recent_runs };
}

/**
 * Full execution history of one task. Sessions are the spine (every run —
 * including pre-Runtime history and enqueue failures — leaves a
 * `channel='task'` session); the durable Runtime run is joined on where one
 * exists and contributes status, error and timing.
 */
export async function listTaskRuns(
  db: DatabaseProvider,
  actor: TaskActor,
  id: number,
  limit = 50,
): Promise<ListTaskRunsResult> {
  if (!Number.isInteger(id)) return err('invalid', 'Invalid task ID');

  const task = await db.scheduledTasks.getById(id);
  if (!task) return err('not_found', 'Task not found');
  if (!canAccess(task, actor)) return err('forbidden', 'Not authorized');

  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const sessions = await db.sessions.list({ taskId: task.id, limit: boundedLimit });
  const runs = await db.runtime.listRunsForSource('automation', `scheduled_task:${task.id}`, 200);
  const runBySession = new Map(runs.filter((run) => run.session_id).map((run) => [run.session_id as string, run]));

  // The session list is paged by updated_at (a later "continue" bumps it);
  // history reads by when the run happened.
  const entries: AutomationRunEntry[] = sessions.map((session) => {
    const run = runBySession.get(session.id);
    return {
      session_id: session.id,
      title: session.title,
      created_at: session.created_at,
      run: run
        ? {
            id: run.id,
            status: run.status,
            trigger: run.source_id.startsWith('manual:') ? 'manual' : 'scheduled',
            error_code: run.error_code,
            error_message: run.error_message,
            started_at: run.started_at,
            ended_at: run.ended_at,
          }
        : null,
    };
  });
  entries.sort((a, b) => b.created_at.localeCompare(a.created_at));

  return { ok: true, task: toView(task), entries };
}

/**
 * Name the value that was refused and what to do instead. A bare
 * "max_steps must be 1-20" left the model re-sending the same 30.
 */
function maxStepsError(given: number): string {
  const range = `max_steps is the per-run tool-step budget and must be 1-${MAX_STEPS_LIMIT}`;
  return given > MAX_STEPS_LIMIT
    ? `${range}; "${given}" is over the cap. Lower it, or split the work across more than one automation.`
    : `${range}; "${given}" is below the minimum. Use at least 1.`;
}

export async function createTask(
  db: DatabaseProvider,
  actor: TaskActor,
  input: CreateTaskInput,
): Promise<MutateTaskResult> {
  const { name, task_prompt, schedule, timezone, max_steps, enabled } = input;

  if (!name || name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
    return err('invalid', `Name must be ${MIN_NAME_LENGTH}-${MAX_NAME_LENGTH} characters`);
  }
  if (!task_prompt || task_prompt.length < MIN_PROMPT_LENGTH || task_prompt.length > MAX_PROMPT_LENGTH) {
    return err('invalid', `Task prompt must be ${MIN_PROMPT_LENGTH}-${MAX_PROMPT_LENGTH} characters`);
  }
  if (!schedule) {
    return err('invalid', 'Schedule (cron expression) is required');
  }

  const cronCheck = validateCron(schedule);
  if (!cronCheck.valid) return err('invalid', cronCheck.error ?? 'Invalid cron expression');

  const tz = timezone ?? DEFAULT_TIMEZONE;
  if (!validateTimezone(tz)) return err('invalid', `Invalid timezone: ${tz}`);

  if (max_steps !== undefined && (max_steps < 1 || max_steps > MAX_STEPS_LIMIT)) {
    return err('invalid', maxStepsError(max_steps));
  }

  const webhookCheck = validateNotifyWebhook(input.notify_webhook);
  if (webhookCheck) return webhookCheck;

  const toolGrant = validateUnattendedTools(input.unattended_tools, actor);
  if (toolGrant && 'ok' in toolGrant) return toolGrant;

  const profileResult = await resolveTaskProfile(input.profile_id, actor, db);
  if ('ok' in profileResult) return profileResult;

  // Quota is per owner — a super creating on the console still fills their own.
  const count = await db.scheduledTasks.countByUser(actor.userId);
  if (count >= MAX_TASKS_PER_USER) {
    return err('invalid', `Maximum ${MAX_TASKS_PER_USER} tasks per user`);
  }

  const task = await db.scheduledTasks.create({
    user_id: actor.userId,
    name,
    profile_id: profileResult.profileId,
    task_prompt: sanitizeForPrompt(task_prompt),
    schedule,
    timezone: tz,
    max_steps: max_steps ?? 15,
    enabled: enabled ?? true,
    notify_webhook: input.notify_webhook || null,
    notify_email: input.notify_email ?? false,
    notify_wecom: input.notify_wecom ?? false,
    notify_feishu: input.notify_feishu ?? false,
    ...(toolGrant ? { unattended_tools: toolGrant.json } : {}),
  });

  const scheduler = getScheduler();
  if (scheduler && task.enabled) {
    await scheduler.reloadTask(task.id);
  }

  logger.info(`[Tasks] Created task "${name}" (id=${task.id}) by ${actor.userId}`);
  return { ok: true, task: toView(task) };
}

export async function updateTask(
  db: DatabaseProvider,
  actor: TaskActor,
  id: number,
  input: UpdateTaskInput,
): Promise<MutateTaskResult> {
  if (!Number.isInteger(id)) return err('invalid', 'Invalid task ID');

  const existing = await db.scheduledTasks.getById(id);
  if (!existing) return err('not_found', 'Task not found');
  if (!canAccess(existing, actor)) return err('forbidden', 'Not authorized');

  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) {
    if (input.name.length < MIN_NAME_LENGTH || input.name.length > MAX_NAME_LENGTH) {
      return err('invalid', `Name must be ${MIN_NAME_LENGTH}-${MAX_NAME_LENGTH} characters`);
    }
    updates.name = input.name;
  }

  if (input.task_prompt !== undefined) {
    if (input.task_prompt.length < MIN_PROMPT_LENGTH || input.task_prompt.length > MAX_PROMPT_LENGTH) {
      return err('invalid', `Task prompt must be ${MIN_PROMPT_LENGTH}-${MAX_PROMPT_LENGTH} characters`);
    }
    updates.task_prompt = sanitizeForPrompt(input.task_prompt);
  }

  if (input.schedule !== undefined) {
    const cronCheck = validateCron(input.schedule);
    if (!cronCheck.valid) return err('invalid', cronCheck.error ?? 'Invalid cron expression');
    updates.schedule = input.schedule;
  }

  if (input.timezone !== undefined) {
    if (!validateTimezone(input.timezone)) return err('invalid', `Invalid timezone: ${input.timezone}`);
    updates.timezone = input.timezone;
  }

  if (input.max_steps !== undefined) {
    if (input.max_steps < 1 || input.max_steps > MAX_STEPS_LIMIT) {
      return err('invalid', maxStepsError(input.max_steps));
    }
    updates.max_steps = input.max_steps;
  }

  if (input.profile_id !== undefined) {
    const profileResult = await resolveTaskProfile(input.profile_id, actor, db);
    if ('ok' in profileResult) return profileResult;
    updates.profile_id = profileResult.profileId;
  }

  if (input.enabled !== undefined) {
    updates.enabled = input.enabled;
  }

  if (input.notify_webhook !== undefined) {
    const webhookCheck = validateNotifyWebhook(input.notify_webhook);
    if (webhookCheck) return webhookCheck;
    updates.notify_webhook = input.notify_webhook || null;
  }

  if (input.notify_wecom !== undefined) {
    updates.notify_wecom = input.notify_wecom;
  }
  if (input.notify_feishu !== undefined) {
    updates.notify_feishu = input.notify_feishu;
  }
  if (input.notify_email !== undefined) {
    updates.notify_email = input.notify_email;
  }

  const toolGrant = validateUnattendedTools(input.unattended_tools, actor);
  if (toolGrant && 'ok' in toolGrant) return toolGrant;
  if (toolGrant) updates.unattended_tools = toolGrant.json;

  const updated = await db.scheduledTasks.update(id, updates);
  if (!updated) return err('internal', 'Update failed');

  const scheduler = getScheduler();
  if (scheduler) {
    await scheduler.reloadTask(id);
  }

  logger.info(`[Tasks] Updated task id=${id} by ${actor.userId}`);
  return { ok: true, task: toView(updated) };
}

/** Delete a task definition. Historical sessions are kept. */
export async function deleteTask(db: DatabaseProvider, actor: TaskActor, id: number): Promise<DeleteTaskResult> {
  if (!Number.isInteger(id)) return err('invalid', 'Invalid task ID');

  const existing = await db.scheduledTasks.getById(id);
  if (!existing) return err('not_found', 'Task not found');
  if (!canAccess(existing, actor)) return err('forbidden', 'Not authorized');

  // Delete from DB first, then remove the in-memory cron job
  try {
    await db.scheduledTasks.delete(id);
  } catch (error) {
    if (error instanceof ScheduledTaskActiveRunError) return err('conflict', error.message);
    throw error;
  }

  const scheduler = getScheduler();
  if (scheduler) {
    scheduler.removeJob(id);
  }

  logger.info(`[Tasks] Deleted task "${existing.name}" (id=${id}) by ${actor.userId}`);
  return { ok: true, name: existing.name };
}

/**
 * Trigger a task immediately. Reservation, session creation and the background
 * launch are one scheduler operation, so concurrent requests cannot create
 * orphan sessions; a task already running returns a conflict.
 */
export async function runTaskNow(db: DatabaseProvider, actor: TaskActor, id: number): Promise<RunTaskResult> {
  if (!Number.isInteger(id)) return err('invalid', 'Invalid task ID');

  const task = await db.scheduledTasks.getById(id);
  if (!task) return err('not_found', 'Task not found');
  if (!canAccess(task, actor)) return err('forbidden', 'Not authorized');

  const scheduler = getScheduler();
  if (!scheduler) return err('unavailable', 'Scheduler not initialized');

  const sessionId = await scheduler.runTaskManually(id, actor.userId);
  if (!sessionId) return err('conflict', 'Task is already running or unavailable');

  logger.info(`[Tasks] Manual trigger task "${task.name}" (id=${id}) by ${actor.userId} → session=${sessionId}`);
  return { ok: true, session_id: sessionId, name: task.name };
}
