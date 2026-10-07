/**
 * Background tasks — admission, listing and cancel (spec §7, design review R15).
 *
 * Built on the Runtime `subagent` kind rather than a new kind: durable
 * admission, lease/heartbeat, cancel, timeouts, reclaim after restart,
 * Execution Center visibility and the parent-deletion guard all come with it.
 * What is Bot-specific here:
 * - admission only from the member's "Start" on a task card (POST
 *   /api/bots/requests/:id) — the model can propose, never start;
 * - child sessions are named `bottask-…`, which is how a Bot task is told
 *   apart from a `spawn_session` child everywhere (counts, lists, copy), and
 *   the Bot + title live in the child's server-written session metadata;
 * - at most 3 running per member.
 *
 * Execution (prompt, read-only face) and the report live in background.ts.
 * This module stays free of the engine's run machinery so the `bot_tasks`
 * tool can import it without a cycle.
 */

import { createHash } from 'node:crypto';
import { getDb, type BotRow, type DatabaseProvider, type RuntimeRunRow } from '@greenhouse/db';
import type { BotTaskView } from '@greenhouse/types/bots';
import type { RuntimeRunStatus } from '@greenhouse/types/runtime';
import { BOT_TASK_SESSION_PREFIX } from '@greenhouse/types/session';
import { safeJsonParse } from '@greenhouse/utils/json';
import { sanitizeForPrompt } from '../../security/security.js';
import { runtimeDriverEnabled } from '../../trusted-execution/kill-switches.js';
import {
  admitSubagentRuntimeRun,
  requestSubagentRuntimeCancellation,
  SUBAGENT_SOURCE_KIND,
} from '../../runtime/subagent-driver.js';

/** The child-session marker of a Bot task (one constant, shared through @greenhouse/types/session). */
export { BOT_TASK_SESSION_PREFIX };
export const MAX_RUNNING_TASKS_PER_MEMBER = 3;
export const BOT_TASK_TIMEOUT_MS = 20 * 60_000;
export const BOT_TASK_MAX_STEPS = 30;
export const BOT_TASK_BRIEF_MAX = 2000;
export const BOT_TASK_TITLE_MAX = 80;
export const TASK_REPORT_MAX_CHARS = 3000;
const ACTIVE_STATUSES: RuntimeRunStatus[] = ['queued', 'claimed', 'running', 'waiting', 'paused'];

export class BotTaskError extends Error {
  constructor(
    readonly code: 'unavailable' | 'limit' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'BotTaskError';
  }
}

export function isBotTaskRun(run: Pick<RuntimeRunRow, 'kind' | 'source_kind' | 'source_id'>): boolean {
  return (
    run.kind === 'subagent' &&
    run.source_kind === SUBAGENT_SOURCE_KIND &&
    run.source_id.startsWith(BOT_TASK_SESSION_PREFIX)
  );
}

/** What admission writes into the child session's metadata (server-only, immutable after admission). */
export interface BotTaskMetadata {
  bot_id: string;
  task_title: string;
}

export function botTaskMetadata(sessionMetadata: string | null | undefined): BotTaskMetadata | null {
  const meta = safeJsonParse(sessionMetadata ?? '{}', {}) as Record<string, unknown>;
  if (meta.spawned_by !== 'bot_task' || typeof meta.bot_id !== 'string' || typeof meta.task_title !== 'string') {
    return null;
  }
  return { bot_id: meta.bot_id, task_title: meta.task_title };
}

// Member-local admission mutex: count-then-admit must not interleave for one member.
const admitting = new Map<string, Promise<unknown>>();

async function countRunningTasks(db: DatabaseProvider, userId: string): Promise<number> {
  const { items } = await db.runtime.listRuns({
    owner_user_id: userId,
    kinds: ['subagent'],
    statuses: ACTIVE_STATUSES,
    limit: 100,
  });
  return items.filter(isBotTaskRun).length;
}

export interface AdmitBotTaskInput {
  db?: DatabaseProvider;
  userId: string;
  conversationId: string;
  bot: BotRow;
  title: string;
  brief: string;
  /** The task_start request — its id makes admission idempotent. */
  requestId: string;
}

/** Admit a confirmed task (called with the member's own credentials, from the request route). */
export async function admitBotTask(input: AdmitBotTaskInput): Promise<{ runId: string; childSessionId: string }> {
  const db = input.db ?? getDb();
  if (!runtimeDriverEnabled('subagent')) {
    throw new BotTaskError('unavailable', 'Background tasks are not available on this deployment');
  }
  const title = input.title.trim().slice(0, BOT_TASK_TITLE_MAX);
  const brief = input.brief.trim().slice(0, BOT_TASK_BRIEF_MAX);
  if (!title || !brief) throw new BotTaskError('invalid', 'A background task needs a title and a brief');

  const digest = createHash('sha256').update(`bot-task\0${input.requestId}`).digest('hex');
  const childSessionId = `${BOT_TASK_SESSION_PREFIX}${digest.slice(0, 40)}`;
  const previous = admitting.get(input.userId) ?? Promise.resolve();
  const work = previous
    .catch(() => undefined)
    .then(async () => {
      // A retry of a request that was already admitted (its settle failed, a
      // second click) replays the same Run below: it must not count against
      // the cap it already holds a slot in.
      const alreadyAdmitted = Boolean(await db.sessions.getById(childSessionId));
      if (!alreadyAdmitted && (await countRunningTasks(db, input.userId)) >= MAX_RUNNING_TASKS_PER_MEMBER) {
        throw new BotTaskError(
          'limit',
          `At most ${MAX_RUNNING_TASKS_PER_MEMBER} background tasks can run at once — wait for one to finish or cancel it`,
        );
      }
      const envelope = await admitSubagentRuntimeRun(db, {
        owner_user_id: input.userId,
        initiated_by_user_id: input.userId,
        child_session_id: childSessionId,
        seed_message_id: `${BOT_TASK_SESSION_PREFIX}seed-${digest.slice(40)}`,
        parent_session_id: input.conversationId,
        parent_runtime_run_id: null,
        profile_id: 'sprouty',
        prompt: sanitizeForPrompt(brief),
        title: `${input.bot.name} · ${title}`,
        depth: 1,
        max_steps: BOT_TASK_MAX_STEPS,
        mode: 'async',
        timeout_ms: BOT_TASK_TIMEOUT_MS,
        workspace_id: null,
        bot_task: { bot_id: input.bot.id, title },
      });
      return { runId: envelope.run.id, childSessionId };
    });
  admitting.set(input.userId, work);
  try {
    return await work;
  } finally {
    if (admitting.get(input.userId) === work) admitting.delete(input.userId);
  }
}

function taskStatus(status: RuntimeRunStatus): BotTaskView['status'] {
  if (status === 'claimed' || status === 'running') return 'running';
  if (status === 'waiting' || status === 'paused') return 'waiting';
  if (status === 'queued') return 'queued';
  return status as BotTaskView['status'];
}

function taskSummary(run: RuntimeRunRow): string | null {
  if (run.status === 'succeeded' && run.output) {
    const output = safeJsonParse(run.output, {}) as { result?: { text?: unknown } };
    const text = typeof output.result?.text === 'string' ? output.result.text : '';
    return text ? text.replace(/\s+/g, ' ').trim().slice(0, 280) : null;
  }
  return run.error_message ? run.error_message.slice(0, 280) : null;
}

/** The background tasks of one conversation, newest first (the task dock). */
export async function listConversationTasks(
  db: DatabaseProvider,
  userId: string,
  conversationId: string,
  limit = 20,
): Promise<BotTaskView[]> {
  const { items } = await db.runtime.listRuns({ owner_user_id: userId, kinds: ['subagent'], limit: 100 });
  const runs = items.filter((run) => {
    if (!isBotTaskRun(run)) return false;
    const input = safeJsonParse(run.input, {}) as { parent_session_id?: unknown };
    return input.parent_session_id === conversationId;
  });
  const views: BotTaskView[] = [];
  for (const run of runs.slice(0, limit)) {
    const child = await db.sessions.getById(run.source_id);
    const meta = botTaskMetadata(child?.metadata);
    if (!meta) continue;
    views.push({
      run_id: run.id,
      bot_id: meta.bot_id,
      title: meta.task_title,
      status: taskStatus(run.status),
      child_session_id: child?.id ?? null,
      summary: taskSummary(run),
      created_at: run.created_at,
      started_at: run.started_at ?? null,
      ended_at: run.settled_at ?? null,
    });
  }
  return views;
}

/** Cancel through the Runtime command fence (same semantics as Execution Center). */
export async function cancelBotTask(
  db: DatabaseProvider,
  userId: string,
  runId: string,
  conversationId?: string,
): Promise<'canceled' | 'not_found' | 'finished'> {
  const run = await db.runtime.getRun(runId);
  if (!run || run.owner_user_id !== userId || !isBotTaskRun(run)) return 'not_found';
  if (conversationId) {
    const input = safeJsonParse(run.input, {}) as { parent_session_id?: unknown };
    if (input.parent_session_id !== conversationId) return 'not_found';
  }
  if (['succeeded', 'failed', 'canceled', 'interrupted'].includes(run.status)) return 'finished';
  await requestSubagentRuntimeCancellation(db, runId, userId, `bots:cancel:${runId}:${Date.now()}`);
  return 'canceled';
}

/**
 * Cancel every background task the member still has queued or running
 * (account suspended or deleted). Best effort per run; returns how many were
 * asked to stop.
 */
export async function cancelBotTasksForUser(db: DatabaseProvider, userId: string): Promise<number> {
  const { items } = await db.runtime.listRuns({ owner_user_id: userId, kinds: ['subagent'], limit: 200 });
  let canceled = 0;
  for (const run of items) {
    if (!isBotTaskRun(run) || ['succeeded', 'failed', 'canceled', 'interrupted'].includes(run.status)) continue;
    if ((await cancelBotTask(db, userId, run.id)) === 'canceled') canceled++;
  }
  return canceled;
}
