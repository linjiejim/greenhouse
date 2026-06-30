/**
 * Task executor — runs a scheduled task by creating a session and invoking the agent.
 *
 * Reuses the same agent infrastructure as chat.ts:
 * - resolveProfile() for profile loading
 * - createModelFromConfig() for LLM model
 * - selectTools() for tool selection
 * - generateText() (non-streaming) for execution
 */

import { toErrorMessage } from '@greenhouse/utils/error';
import { Cron } from 'croner';
import { getDb } from '@greenhouse/db';
import { selectTools, buildSystemPrompt } from '../agent.js';
import type { ToolRegistry } from '../agent.js';
import { runAgentInSession } from '../agent-runtime/run-agent.js';
import { resolveProfile } from '../profile.js';
import { sanitizeForPrompt } from '../security.js';
import { buildTaskPrompt, buildTaskSessionTitle } from './prompt-builder.js';
import { logger } from '@greenhouse/utils/logger';
import type { ScheduledTaskRow } from '@greenhouse/db';

/**
 * Prepare a task for execution: create session + user message.
 * Returns the session ID immediately. Call executeTaskInSession() to run the agent.
 */
export async function prepareTask(task: ScheduledTaskRow): Promise<string> {
  const db = getDb();

  // 1. Resolve profile (validate it exists)
  resolveProfile(task.profile_id);

  // 2. Create a new session for this execution
  const title = buildTaskSessionTitle(task.name, task.timezone);
  const session = await db.sessions.create(
    title,
    task.profile_id,
    task.user_id,
    undefined,
    'task', // channel
  );

  // Store task_id in session metadata for back-reference
  await db.sessions.update(session.id, {
    metadata: JSON.stringify({ task_id: task.id, task_name: task.name }),
  });

  // 3. Build the task prompt with time context and add user message
  const prompt = buildTaskPrompt(task.task_prompt, task.timezone);
  await db.sessions.addMessage({
    session_id: session.id,
    role: 'user',
    content: prompt,
  });

  return session.id;
}

/**
 * Execute a scheduled task end-to-end: create session → run agent → persist results.
 *
 * @returns The created session ID, or null if execution failed before session creation.
 */
export async function executeTask(task: ScheduledTaskRow, toolRegistry: ToolRegistry): Promise<string | null> {
  const db = getDb();

  logger.info(`[Scheduler] ▶ Starting task "${task.name}" (id=${task.id})`);

  // 1. Mark as running
  await db.scheduledTasks.updateRunStatus(task.id, 'running');

  let sessionId: string | null = null;

  try {
    // 2. Prepare session
    sessionId = await prepareTask(task);

    // 3. Execute agent in the session (handles its own error persistence)
    await executeTaskInSession(task, sessionId, toolRegistry);

    return sessionId;
  } catch (err) {
    // If prepareTask itself failed (no session created), log and update status
    if (!sessionId) {
      const errorMsg = toErrorMessage(err);
      logger.error(`[Scheduler] ❌ Task "${task.name}" failed to prepare: ${errorMsg}`);
      const nextRunAt = calculateNextRun(task.schedule, task.timezone);
      await db.scheduledTasks.updateRunStatus(task.id, 'failed', nextRunAt);
    }
    // If sessionId exists, executeTaskInSession already handled error persistence
    return sessionId;
  }
}

/**
 * Execute the agent in an already-prepared session.
 * Called either from executeTask() or from the manual run API.
 */
export async function executeTaskInSession(
  task: ScheduledTaskRow,
  sessionId: string,
  toolRegistry: ToolRegistry,
): Promise<void> {
  const db = getDb();

  try {
    // 6. Execute agent (non-streaming) via the shared runner — it builds the
    // model, runs the bounded loop, and persists the assistant message + pipeline.
    const profile = resolveProfile(task.profile_id);
    // Re-sanitize prompt from DB as defense-in-depth against prompt injection
    const sanitizedPrompt = sanitizeForPrompt(task.task_prompt);
    const prompt = buildTaskPrompt(sanitizedPrompt, task.timezone);
    const tools = selectTools(toolRegistry, profile.tools);
    const systemPrompt = buildSystemPrompt(profile);
    const maxSteps = task.max_steps ?? profile.max_steps ?? 12;

    const result = await runAgentInSession({
      sessionId,
      system: systemPrompt,
      prompt,
      modelConfig: profile.model,
      tools,
      maxSteps,
      toolChoice: profile.tool_choice,
    });

    // Keep session 'active' so it shows in the sidebar; update task run status.
    const nextRunAt = calculateNextRun(task.schedule, task.timezone);
    await db.scheduledTasks.updateRunStatus(task.id, 'completed', nextRunAt);

    logger.info(
      `[Scheduler] ✅ Task "${task.name}" completed in ${result.durationMs}ms ` +
        `(session=${sessionId}, tokens=${result.usage?.inputTokens ?? 0}+${result.usage?.outputTokens ?? 0})`,
    );
  } catch (err) {
    const errorMsg = toErrorMessage(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    logger.error(`[Scheduler] ❌ Task "${task.name}" in session ${sessionId} failed: ${errorMsg}`);
    if (errorStack) logger.error(`[Scheduler] Stack: ${errorStack}`);

    // Write error to session
    try {
      await db.sessions.addMessage({
        session_id: sessionId,
        role: 'assistant',
        content: `⚠️ 任务执行失败: ${errorMsg}\n\n请检查任务配置或稍后重试。`,
      });
      await db.sessions.touch(sessionId);
    } catch {
      // Ignore persistence errors during error handling
    }

    // Update task status
    const nextRunAt = calculateNextRun(task.schedule, task.timezone);
    await db.scheduledTasks.updateRunStatus(task.id, 'failed', nextRunAt);

    throw err; // Re-throw so caller knows it failed
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
