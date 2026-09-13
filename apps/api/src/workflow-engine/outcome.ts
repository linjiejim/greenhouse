/**
 * Run settlement — the single terminal transition, plus the conversation
 * write-back that goes with it.
 *
 * A workflow run reaches a terminal state from four independent places (the
 * drive loop completing, the drive loop declaring a stall, an escalation gate
 * being aborted, a user cancel). All four go through `settleRun` so that:
 *
 *  1. The transition is a compare-and-set — exactly one caller wins, even when
 *     a cancel races the loop's own finalization.
 *  2. The orchestrating conversation gets exactly one assistant message about
 *     the outcome. This is the same discipline the Cloud Agent controller uses
 *     (`appendOutcomeMessage` next to a winning CAS, never inside a repeatable
 *     recovery path) — a boot sweep that re-drives a run may legitimately reach
 *     a terminal state and write then, but it can never re-write one already
 *     written.
 *
 * v1 deliberately kept deliverables out of the transcript ("don't fake
 * assistant messages in the orchestration session"). That held while the run
 * card was the only consumer and workflows were a separate mode; now the
 * message flow is the single delivery surface for all three session modes, and
 * the outcome message doubles as context for the next chat turn (session modes
 * spec D3).
 */

import { nowIso } from '@greenhouse/utils/date';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';
import { splitWorkflowSummary } from '@greenhouse/types/workflow';
import type { WorkflowRunRow } from '@greenhouse/db';
import type { EngineDb } from './deps.js';

export type WorkflowTerminalStatus = 'completed' | 'failed' | 'canceled';

/** Every non-terminal status — the CAS guard for "this run is still ours to finish". */
const NON_TERMINAL: ReadonlyArray<'running' | 'paused' | 'paused_for_gate'> = ['running', 'paused', 'paused_for_gate'];

export interface SettleRunPatch {
  status: WorkflowTerminalStatus;
  /** JSON-encoded deliverable outputs (completed runs only). */
  summary?: string;
  error?: string | null;
}

/**
 * Move a run to a terminal state and close its conversation turn.
 * Returns true when THIS call won the transition (and therefore wrote the
 * message); false when the run was already finished by someone else.
 */
export async function settleRun(db: EngineDb, runId: string, patch: SettleRunPatch): Promise<boolean> {
  const won = await db.workflows.transitionRun(runId, NON_TERMINAL, {
    status: patch.status,
    ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    finished_at: nowIso(),
  });
  if (!won) return false;
  await appendOutcomeMessage(db, won);
  return true;
}

/**
 * Write the run's outcome into the orchestrating conversation. Failures are
 * logged, never thrown: a transcript write must not turn a finished run into a
 * crashed drive loop.
 */
async function appendOutcomeMessage(db: EngineDb, run: WorkflowRunRow): Promise<void> {
  try {
    const wf = await db.workflows.getById(run.workflow_id);
    const sessionId = wf?.created_from_session_id;
    if (!sessionId) return; // no orchestrating conversation (API-created run)

    await db.sessions.addMessage({
      session_id: sessionId,
      role: 'assistant',
      content: outcomeContent(run.status as WorkflowTerminalStatus, wf.name, run.summary, run.error),
    });
    await db.sessions.touch(sessionId);
  } catch (err) {
    logger.error('[workflow-engine] failed to append outcome message', { runId: run.id, err: String(err) });
  }
}

/** The assistant message body for each terminal state (exported for tests). */
export function outcomeContent(
  status: WorkflowTerminalStatus,
  workflowName: string,
  summary: string | null,
  error: string | null,
): string {
  if (status === 'canceled') return `Workflow “${workflowName}” was canceled.`;
  if (status === 'failed') return `Workflow “${workflowName}” failed: ${error ?? 'unknown error'}`;

  const body = deliverableBody(summary);
  const head = body || `Workflow “${workflowName}” completed.`;
  return `${head}\n\n_The full deliverable is in the task dock above the composer — copy, download, or file it into the knowledge base there._`;
}

/**
 * The prose part of the deliverable node's output, using the SAME heuristic the
 * deliverable panel renders with (`splitWorkflowSummary`) so the message and
 * the card never disagree about what the deliverable was.
 */
function deliverableBody(summary: string | null): string {
  if (!summary) return '';
  const parsed = safeJsonParse(summary, null);
  if (typeof parsed === 'string') return parsed.trim();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  return splitWorkflowSummary(parsed as Record<string, unknown>).body.trim();
}
