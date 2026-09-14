/**
 * Task executor — runs a scheduled task by creating a session and invoking the agent.
 *
 * Reuses the same agent infrastructure as chat.ts:
 * - resolveProfileAsync() for system/custom immutable profile loading
 * - profile tools ∩ resolveEffectiveTools() for current-owner permission resolution
 * - buildLazyServerTools() for per-session tool assembly
 * - generateText() (non-streaming) for execution
 */

import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import { normalizeAutomationOptInTools } from '@greenhouse/types/automation-tools';
import { Cron } from 'croner';
import { getDb, type DatabaseProvider } from '@greenhouse/db';
import { selectTools, buildSystemPrompt } from '../agent.js';
import { resolveMemoryContext } from '../llm/memory.js';
import type { UserRole } from '../auth/token.js';
import type { ToolRegistry } from '../agent.js';
import { runAgentInSession, SessionTranscriptChangedError } from '../agent-runtime/run-agent.js';
import {
  buildLazyServerTools,
  filterUnattendedToolIds,
  LAZY_TOOL_IDS,
  resolveEffectiveTools,
} from '../agent-runtime/tool-resolution.js';
import { assertPinnedProfileExecutionAccess, resolveProfileAsync } from '../profiles/profile.js';
import { sanitizeForPrompt } from '../security/security.js';
import { buildTaskPrompt, buildTaskSessionTitle } from './prompt-builder.js';
import { notifyTaskResult } from './notify.js';
import { logger } from '@greenhouse/utils/logger';
import type { ScheduledTaskRow } from '@greenhouse/db';
import type { RuntimeToolEvidenceScope } from '../runtime/tool-evidence.js';

export interface ActiveTaskOwner {
  id: string;
  role: 'team' | 'super';
}

/**
 * The owner's per-automation tool grant, as stored.
 *
 * `safeJsonParse` rather than a bare `JSON.parse`: this is a JSON-as-text
 * column, and a corrupt value must degrade to "no extra tools" — the
 * fail-closed direction — instead of throwing and turning every run of that
 * automation into a failure.
 */
function optInTools(task: ScheduledTaskRow): unknown {
  return safeJsonParse(task.unattended_tools, []);
}

export type TaskOwnerState = { state: 'active'; owner: ActiveTaskOwner } | { state: 'paused' } | { state: 'invalid' };

export async function resolveTaskOwnerState(
  task: ScheduledTaskRow,
  db: DatabaseProvider = getDb(),
): Promise<TaskOwnerState> {
  const owner = await db.users.getById(task.user_id);
  if (!owner || (owner.role !== 'team' && owner.role !== 'super')) return { state: 'invalid' };
  if (owner.status === 'invited' || owner.status === 'reset_required') return { state: 'paused' };
  if (owner.status !== 'active') return { state: 'invalid' };
  return { state: 'active', owner: { id: owner.id, role: owner.role } };
}

/**
 * Resolve the task owner from the database at the point of use.
 *
 * Scheduled tasks are long-lived credentials in practice: they can outlive a
 * login token and an in-memory cron registration. Never trust the role/status
 * captured when the task was created. A missing, disabled, or legacy external
 * owner fails closed.
 */
export async function resolveActiveTaskOwner(
  task: ScheduledTaskRow,
  db: DatabaseProvider = getDb(),
): Promise<ActiveTaskOwner | null> {
  const state = await resolveTaskOwnerState(task, db);
  return state.state === 'active' ? state.owner : null;
}

async function requireActiveTaskOwner(
  task: ScheduledTaskRow,
  db: DatabaseProvider = getDb(),
): Promise<ActiveTaskOwner> {
  const owner = await resolveActiveTaskOwner(task, db);
  if (!owner) {
    throw new Error('Scheduled task owner is not an active internal user');
  }
  return owner;
}

/** Validate every mutable prerequisite before an execution is admitted. */
export async function validateTaskExecution(task: ScheduledTaskRow, db: DatabaseProvider = getDb()): Promise<void> {
  const current = await db.scheduledTasks.getById(task.id);
  if (!current || current.user_id !== task.user_id || current.profile_id !== task.profile_id) {
    throw new Error('Scheduled task was deleted or changed after this occurrence was admitted');
  }
  const owner = await requireActiveTaskOwner(task, db);
  await assertPinnedProfileExecutionAccess(db, owner, task.profile_id, 'Automation');
  await resolveProfileAsync(task.profile_id, db);
}

/**
 * The tool base for a scheduled run is `resolveEffectiveTools` — the SAME
 * resolution chat uses. System profiles run with the owner's full allow-set
 * (their YAML `tools:` list is not a runtime narrowing anywhere else — chat
 * ignores it, and fork-seeding was fixed 2026-08-13 for the same reason);
 * custom profiles are already narrowed to declared ∪ builtins inside
 * `resolveEffectiveTools`. Re-intersecting with the raw YAML list here used to
 * clamp system-profile automations to 3 read tools and strip the builtins from
 * custom-profile ones. The unattended filter on top stays fail-closed: only
 * catalogued replay-safe reads survive automatically, so this base can never
 * leak a write or a confirm-gated tool into a run nobody is watching.
 *
 * On top of that baseline the OWNER may grant extra tools per automation
 * (`scheduled_tasks.unattended_tools`, see
 * docs/specs/20260824-automation-optin-tools.md). That grant is a filter, not a
 * permission: it is intersected here with `effectiveToolIds`, which
 * `executeTaskInSession` re-resolves from the current owner immediately before
 * every run. `email_mutation`, `automation_mutation` and the draft-only
 * dispatch tools stay unreachable no matter what is stored in the column.
 */
export function scheduledToolBase(effectiveToolIds: string[], optInToolIds: readonly string[] = []): string[] {
  return filterUnattendedToolIds(effectiveToolIds, optInToolIds);
}

/**
 * Prepare a task for execution: create session + user message.
 * Returns the session ID immediately. Call executeTaskInSession() to run the agent.
 */
export interface PrepareTaskOptions {
  /** Runtime uses a deterministic session id to close create/claim crash windows. */
  sessionId?: string;
  runtimeRunId?: string;
  trigger?: 'scheduled' | 'manual';
  scheduledFor?: string;
  preparedPrompt?: string;
  sessionTitle?: string;
}

export async function prepareTask(
  task: ScheduledTaskRow,
  options: PrepareTaskOptions = {},
  db: DatabaseProvider = getDb(),
): Promise<string> {
  // 1. Revalidate the current owner before creating any execution artifacts.
  const owner = await requireActiveTaskOwner(task, db);
  await assertPinnedProfileExecutionAccess(db, owner, task.profile_id, 'Automation');

  // 2. Resolve the immutable/pinned profile (validate it still exists).
  await resolveProfileAsync(task.profile_id, db);

  // 3. Create a new session for this execution
  const reference = options.scheduledFor ? new Date(options.scheduledFor) : new Date();
  const title = options.sessionTitle ?? buildTaskSessionTitle(task.name, task.timezone, reference);
  const metadata = JSON.stringify({
    task_id: task.id,
    task_name: task.name,
    ...(options.runtimeRunId ? { automation_runtime_run_id: options.runtimeRunId } : {}),
    ...(options.trigger ? { automation_trigger: options.trigger } : {}),
    ...(options.scheduledFor ? { scheduled_for: options.scheduledFor } : {}),
  });
  let session = options.sessionId ? await db.sessions.getById(options.sessionId) : undefined;
  if (!session) {
    try {
      session = await db.sessions.create(title, task.profile_id, task.user_id, undefined, 'task', undefined, {
        ...(options.sessionId ? { id: options.sessionId } : {}),
        metadata,
      });
    } catch (error) {
      if (!options.sessionId) throw error;
      session = await db.sessions.getById(options.sessionId);
      if (!session) throw error;
    }
  }
  if (session.user_id !== task.user_id || session.profile_id !== task.profile_id || session.channel !== 'task') {
    throw new Error(`Scheduled task session ${session.id} does not match its immutable Runtime owner/profile`);
  }
  // Replays may arrive after the first session insert but before metadata was
  // visible to an older caller. The exact Runtime snapshot is authoritative.
  await db.sessions.update(session.id, { metadata });

  // 4. Build the task prompt with time context and add user message
  const prompt =
    options.preparedPrompt ?? buildTaskPrompt(sanitizeForPrompt(task.task_prompt), task.timezone, reference);
  await db.sessions.addMessageOnce(`automation-prompt:${session.id}`, {
    session_id: session.id,
    role: 'user',
    content: prompt,
  });

  return session.id;
}

/**
 * Execute the agent in an already-prepared session.
 * Called only by a durable Runtime driver.
 */
export async function executeTaskInSession(
  task: ScheduledTaskRow,
  sessionId: string,
  toolRegistry: ToolRegistry,
  options: {
    db?: DatabaseProvider;
    abortSignal?: AbortSignal;
    runtimeRunId?: string;
    deferLifecycle?: boolean;
    runtimeToolEvidence?: Omit<RuntimeToolEvidenceScope, 'db'>;
  } = {},
) {
  const db = options.db ?? getDb();

  try {
    // Re-read the owner immediately before permission/tool resolution. This is
    // the final fail-closed boundary for direct calls and role/status changes
    // that happen after a cron job was registered or a session was prepared.
    const owner = await requireActiveTaskOwner(task, db);
    await assertPinnedProfileExecutionAccess(db, owner, task.profile_id, 'Automation');

    // Execute agent (non-streaming) via the shared runner — it builds the
    // model, runs the bounded loop, and persists the assistant message + pipeline.
    const profile = await resolveProfileAsync(task.profile_id, db);
    // The prepared session message is the canonical task prompt. Rebuilding it
    // here would change its time context (and historically sanitized only this
    // copy), defeating the exact-tail compare-and-set in the shared runner.
    const preparedPrompt = await db.sessions.getLatestMessage(sessionId);
    if (!preparedPrompt || preparedPrompt.role !== 'user') {
      throw new Error('Scheduled task session has no prepared user prompt');
    }
    const prompt = preparedPrompt.content;
    const { effectiveTools } = await resolveEffectiveTools({
      userId: owner.id,
      userRole: owner.role,
      profile,
      profileId: task.profile_id,
    });
    const scheduledToolIds = scheduledToolBase(effectiveTools, normalizeAutomationOptInTools(optInTools(task)));
    const tools = selectTools(
      toolRegistry,
      scheduledToolIds.filter((toolId) => !LAZY_TOOL_IDS.has(toolId)),
    );
    Object.assign(
      tools,
      buildLazyServerTools(db, scheduledToolIds, {
        userId: owner.id,
        userRole: owner.role,
        sessionId,
        profileId: profile.id,
        toolRegistry,
        unattended: true,
        runtimeRunId: options.runtimeRunId ?? null,
      }),
    );
    // Scheduled runs act for their owner, so they get the owner's memory index
    // (same gate as chat). Without this, "remember I want X" silently fails to
    // apply on exactly the unattended runs the user isn't watching.
    const memoryBlock = await resolveMemoryContext(owner.id, owner.role as UserRole);
    const systemPrompt = buildSystemPrompt(profile, memoryBlock ? { userInfo: memoryBlock } : undefined);
    const maxSteps = task.max_steps ?? profile.max_steps ?? 12;

    const result = await runAgentInSession({
      db,
      sessionId,
      system: systemPrompt,
      prompt,
      modelConfig: profile.model,
      tools,
      maxSteps,
      toolChoice: profile.tool_choice,
      usageContext: { profileId: profile.id, userId: owner.id, caller: 'scheduled-task' },
      ...(options.runtimeToolEvidence ? { runtimeToolEvidence: options.runtimeToolEvidence } : {}),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });

    if (!options.deferLifecycle) await completeTaskExecution(task, sessionId, result.text ?? '', db);

    logger.info(
      `[Scheduler] ✅ Task "${task.name}" completed in ${result.durationMs}ms ` +
        `(session=${sessionId}, tokens=${result.usage?.inputTokens ?? 0}+${result.usage?.outputTokens ?? 0})`,
    );
    return result;
  } catch (err) {
    const errorMsg = toErrorMessage(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    logger.error(`[Scheduler] ❌ Task "${task.name}" in session ${sessionId} failed: ${errorMsg}`);
    if (errorStack) logger.error(`[Scheduler] Stack: ${errorStack}`);

    if (!options.deferLifecycle) {
      await failTaskExecution(task, sessionId, errorMsg, err instanceof SessionTranscriptChangedError, db);
    }

    throw err; // Re-throw so caller knows it failed
  }
}

export async function completeTaskExecution(
  task: ScheduledTaskRow,
  sessionId: string,
  summary: string,
  db: DatabaseProvider = getDb(),
  notify = true,
): Promise<void> {
  await db.scheduledTasks.updateRunStatus(task.id, 'completed', calculateNextRun(task.schedule, task.timezone));
  if (notify) await notifyTaskResult(db, task, { status: 'completed', summary, sessionId });
}

export async function notifyCompletedTaskExecution(
  task: ScheduledTaskRow,
  sessionId: string,
  summary: string,
  db: DatabaseProvider = getDb(),
): Promise<void> {
  await notifyTaskResult(db, task, { status: 'completed', summary, sessionId });
}

export async function failTaskExecution(
  task: ScheduledTaskRow,
  sessionId: string,
  errorMessage: string,
  transcriptChanged = false,
  db: DatabaseProvider = getDb(),
): Promise<void> {
  await recordFailedTaskSession(sessionId, errorMessage, transcriptChanged, db);
  await db.scheduledTasks.updateRunStatus(task.id, 'failed', calculateNextRun(task.schedule, task.timezone));
  await notifyTaskResult(db, task, { status: 'failed', summary: errorMessage, sessionId });
}

export async function recordFailedTaskSession(
  sessionId: string,
  errorMessage: string,
  transcriptChanged = false,
  db: DatabaseProvider = getDb(),
): Promise<void> {
  if (transcriptChanged) return;
  await db.sessions.addMessageOnce(`automation-failed:${sessionId}`, {
    session_id: sessionId,
    role: 'assistant',
    content: `⚠️ 任务执行失败: ${errorMessage}\n\n请检查任务配置或稍后重试。`,
  });
  await db.sessions.touch(sessionId);
}

export async function cancelTaskExecution(
  task: ScheduledTaskRow,
  sessionId: string,
  db: DatabaseProvider = getDb(),
): Promise<void> {
  await recordCanceledTaskSession(sessionId, db);
  await db.scheduledTasks.updateRunStatus(task.id, 'canceled', calculateNextRun(task.schedule, task.timezone));
}

export async function recordCanceledTaskSession(sessionId: string, db: DatabaseProvider = getDb()): Promise<void> {
  try {
    await db.sessions.addMessageOnce(`automation-canceled:${sessionId}`, {
      session_id: sessionId,
      role: 'assistant',
      content: '任务已取消。',
    });
    await db.sessions.touch(sessionId);
  } catch {
    // Runtime remains the cancellation fact even if the transcript write fails.
  }
}

/**
 * Calculate the next run time from a cron expression.
 */
function calculateNextRun(cronExpr: string, timezone: string): string | null {
  try {
    const job = new Cron(cronExpr, { timezone });
    const next = job.nextRun();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}
