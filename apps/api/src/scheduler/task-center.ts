import { notificationTransports } from '../notifications/transports.js';
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
import { toRowId } from '@greenhouse/utils/id';
import type { AutomationRunEntry } from '@greenhouse/types/api';
import { AUTOMATION_OPT_IN_TOOLS, isAutomationOptInTool } from '@greenhouse/types/automation-tools';
import {
  ScheduledTaskActiveRunError,
  type AutomationNotify,
  type DatabaseProvider,
  type ScheduledTaskRow,
  type ScheduledTaskUpdateInput,
} from '@greenhouse/db';
import { resolveProfileAsync } from '../profiles/profile.js';
import { pinProfileIdForUser, ProfileAccessError } from '../profiles/access.js';
import { sanitizeForPrompt } from '../security/security.js';
import { getScheduler } from './index.js';
import {
  DEFAULT_TIMEZONE,
  MAX_NAME_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_STEPS_LIMIT,
  MAX_TASKS_PER_USER,
  MIN_INTERVAL_MINUTES,
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
   * True for the HTTP console (the user's own Bearer, checkboxes they ticked)
   * and for `automation_mutation` called from a person's web or mobile chat turn
   * (the owner asks for the capability in their own words). Every other surface
   * — automation runs, MCP, the agent proxy, Feishu/WeCom bots — leaves it off.
   * The grant can still only name catalogued tools, never widens the owner's
   * permissions, and never reaches destructive actions.
   */
  canGrantTools?: boolean;
}

export type TaskErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict' | 'unavailable' | 'internal';
export type TaskError = { ok: false; code: TaskErrorCode; error: string };
function isTaskError(value: Partial<AutomationNotify> | TaskError | undefined): value is TaskError {
  return value?.ok === false && typeof value.code === 'string' && typeof value.error === 'string';
}
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
  /**
   * Where a finished run is reported (stored as one object). `webhook` is an
   * optional WeCom / Feishu group-bot URL; `email` / `wecom` / `feishu` deliver
   * to the OWNER (recipients are derived, so those channels cannot be aimed).
   * On update only the keys given change.
   */
  notify?: Partial<AutomationNotify> | null;
  /**
   * Stay quiet when a run has nothing new: the run prompt asks for exactly
   * `NO_UPDATE` in that case, and such a run is recorded as "no update" with no
   * notification on any channel.
   */
  quiet_when_empty?: boolean;
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
    // Check the minimum interval between two consecutive fires.
    const next1 = job.nextRun();
    if (!next1) return { valid: false, error: 'Cron expression has no next run' };
    const next2 = job.nextRuns(2);
    if (next2.length >= 2) {
      const intervalMs = next2[1]!.getTime() - next2[0]!.getTime();
      if (intervalMs < MIN_INTERVAL_MS) {
        return { valid: false, error: `Minimum interval is ${MIN_INTERVAL_MINUTES} minutes` };
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
  if (!notificationTransports().some((t) => t.acceptsWebhook?.(url))) {
    return err('invalid', 'Webhook must match an enabled notification transport');
  }
  return null;
}

/**
 * The notify keys a request supplied in `notify`, or `undefined` when it supplied
 * none. Values are type checked; the webhook URL is validated by `validateNotifyWebhook`.
 */
export function notifyFromInput(input: CreateTaskInput): Partial<AutomationNotify> | TaskError | undefined {
  const out: Partial<AutomationNotify> = {};
  if (input.notify !== undefined && input.notify !== null) {
    if (typeof input.notify !== 'object' || Array.isArray(input.notify)) {
      return err(
        'invalid',
        'notify must be an object like {"webhook": null, "email": true, "wecom": false, "feishu": false}',
      );
    }
    const notify = input.notify;
    for (const [key, value] of Object.entries(notify)) {
      if (key !== 'webhook') {
        if (typeof value !== 'boolean') return err('invalid', `notify.${key} must be true or false`);
        out[key] = value;
      }
    }
    if (notify.webhook !== undefined) out.webhook = notify.webhook || null;
    if (notify.email !== undefined) out.email = notify.email;
    if (notify.wecom !== undefined) out.wecom = notify.wecom;
    if (notify.feishu !== undefined) out.feishu = notify.feishu;
  }
  if (out.webhook !== undefined && out.webhook !== null && typeof out.webhook !== 'string') {
    return err('invalid', 'notify.webhook must be a URL string or null');
  }
  for (const key of ['email', 'wecom', 'feishu'] as const) {
    if (out[key] !== undefined && typeof out[key] !== 'boolean')
      return err('invalid', `notify.${key} must be true or false`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate an `unattended_tools` grant and return the canonical list to store.
 *
 * Returns `undefined` when the caller did not supply the field at all (so
 * `update` leaves the stored grant alone), a `TaskError` when it is refused,
 * and `{ tools }` otherwise.
 *
 * Unknown ids are REFUSED rather than dropped: a checkbox we silently ignored
 * is a checkbox that lies about what the automation may do. The message quotes
 * the offending id and lists what is grantable, because an error that only says
 * "invalid" leaves the caller guessing (api AGENTS, "错误文案应当指路").
 */
export function validateUnattendedTools(
  raw: string[] | undefined,
  actor: TaskActor,
): { tools: string[] } | TaskError | undefined {
  if (raw === undefined) return undefined;
  if (!actor.canGrantTools) {
    return err(
      'forbidden',
      'unattended_tools can only be granted by the automation owner — in Settings → Automations → edit → Tools, ' +
        'or by asking for it in the Greenhouse web or mobile chat. This surface cannot grant them.',
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
  return { tools: grantable.filter((id) => picked.has(id)) };
}

/** Owner-or-(super in 'any' scope). Agent tools stay owner-only by construction. */
function canAccess(task: ScheduledTaskRow, actor: TaskActor): boolean {
  if (task.user_id === actor.userId) return true;
  return actor.scope === 'any' && actor.role === 'super';
}

/**
 * Resolve + validate the profile an automation runs as, returning the error
 * message on failure. A system profile, or a run profile (`custom:<id>`) the
 * OWNER may use — their own or one shared with the team — pinned to its current
 * version (`custom:<id>@<v>`). The owner is who the scheduler runs it as, so a
 * super editing a member's automation cannot hand it a profile the member may
 * not use; the run re-checks the same rule (assertPinnedProfileExecutionAccess)
 * and fails with the reason if access went away since.
 */
async function resolveTaskProfile(
  rawProfileId: string | undefined,
  actor: TaskActor,
  owner: { id: string; role: string },
  database: DatabaseProvider,
  existingPin = false,
): Promise<{ profileId: string } | TaskError> {
  try {
    if (actor.role !== 'team' && actor.role !== 'super') return err('forbidden', 'Internal account required');
    if (owner.role !== 'team' && owner.role !== 'super') return err('forbidden', 'The owner is not an internal user');
    const profileId = await pinProfileIdForUser({ id: owner.id, role: owner.role }, rawProfileId, database, {
      existingPin,
    });
    const accessError = await checkProfileAccess(profileId, database);
    if (accessError) return err('forbidden', accessError);
    return { profileId };
  } catch (error) {
    if (error instanceof ProfileAccessError && error.status === 403) {
      return err('forbidden', `The automation's owner cannot use this run profile: ${error.message}`);
    }
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
export async function getTask(db: DatabaseProvider, actor: TaskActor, rawId: string | number): Promise<GetTaskResult> {
  const id = toRowId(rawId);
  if (!id) return err('invalid', 'Invalid task ID');

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
  rawId: string | number,
  limit = 50,
): Promise<ListTaskRunsResult> {
  const id = toRowId(rawId);
  if (!id) return err('invalid', 'Invalid task ID');

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
            no_update: run.status === 'succeeded' && runOutputFlag(run.output, 'no_update'),
            outcome_unknown: run.status === 'interrupted',
          }
        : null,
    };
  });
  entries.sort((a, b) => b.created_at.localeCompare(a.created_at));

  return { ok: true, task: toView(task), entries };
}

/** Read one boolean flag off a Runtime run's JSON output; anything malformed reads as false. */
function runOutputFlag(output: unknown, key: string): boolean {
  return !!output && typeof output === 'object' && (output as Record<string, unknown>)[key] === true;
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

  const notify = notifyFromInput(input);
  if (isTaskError(notify)) return notify;
  const webhookCheck = validateNotifyWebhook(notify?.webhook);
  if (webhookCheck) return webhookCheck;

  const toolGrant = validateUnattendedTools(input.unattended_tools, actor);
  if (toolGrant && 'ok' in toolGrant) return toolGrant;

  // The creator is the owner.
  const profileResult = await resolveTaskProfile(input.profile_id, actor, { id: actor.userId, role: actor.role }, db);
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
    ...(notify ? { notify } : {}),
    quiet_when_empty: input.quiet_when_empty === true,
    ...(toolGrant ? { unattended_tools: toolGrant.tools } : {}),
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
  rawId: string | number,
  input: UpdateTaskInput,
): Promise<MutateTaskResult> {
  const id = toRowId(rawId);
  if (!id) return err('invalid', 'Invalid task ID');

  const existing = await db.scheduledTasks.getById(id);
  if (!existing) return err('not_found', 'Task not found');
  if (!canAccess(existing, actor)) return err('forbidden', 'Not authorized');

  const updates: ScheduledTaskUpdateInput = {};

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
    // Saving an Automation without changing its profile keeps its own pin.
    const ownerRow =
      existing.user_id === actor.userId ? { role: actor.role } : await db.users.getById(existing.user_id);
    const profileResult = await resolveTaskProfile(
      input.profile_id,
      actor,
      { id: existing.user_id, role: ownerRow?.role ?? 'none' },
      db,
      input.profile_id === existing.profile_id,
    );
    if ('ok' in profileResult) return profileResult;
    updates.profile_id = profileResult.profileId;
  }

  if (input.enabled !== undefined) {
    updates.enabled = input.enabled;
  }

  const notify = notifyFromInput(input);
  if (isTaskError(notify)) return notify;
  if (notify) {
    if (notify.webhook !== undefined) {
      const webhookCheck = validateNotifyWebhook(notify.webhook);
      if (webhookCheck) return webhookCheck;
    }
    updates.notify = notify;
  }
  if (input.quiet_when_empty !== undefined) {
    if (typeof input.quiet_when_empty !== 'boolean') return err('invalid', 'quiet_when_empty must be true or false');
    updates.quiet_when_empty = input.quiet_when_empty;
  }

  const toolGrant = validateUnattendedTools(input.unattended_tools, actor);
  if (toolGrant && 'ok' in toolGrant) return toolGrant;
  if (toolGrant) updates.unattended_tools = toolGrant.tools;

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
export async function deleteTask(
  db: DatabaseProvider,
  actor: TaskActor,
  rawId: string | number,
): Promise<DeleteTaskResult> {
  const id = toRowId(rawId);
  if (!id) return err('invalid', 'Invalid task ID');

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
export async function runTaskNow(
  db: DatabaseProvider,
  actor: TaskActor,
  rawId: string | number,
): Promise<RunTaskResult> {
  const id = toRowId(rawId);
  if (!id) return err('invalid', 'Invalid task ID');

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
