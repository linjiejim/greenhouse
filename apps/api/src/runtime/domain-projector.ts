import { emitExtensionEvent } from '../plugin-host/events.js';
/** Durable Runtime terminal/recovery event → source-domain repair. */

import type { DatabaseProvider } from '@greenhouse/db';
import type { RuntimeJsonValue } from '@greenhouse/types/runtime';
import { reconcileReclaimedAutomationRun } from '../scheduler/runtime-driver.js';
import { normalizeSnapshotTask } from '../scheduler/task-snapshot.js';
import { notifyTaskResult } from '../scheduler/notify.js';
import type { RuntimeEventEnvelope } from './worker.js';

function record(value: RuntimeJsonValue | undefined): Record<string, RuntimeJsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, RuntimeJsonValue>)
    : null;
}

function automationInput(run: Awaited<ReturnType<DatabaseProvider['runtime']['getRun']>>): {
  task: Parameters<typeof notifyTaskResult>[1];
  session_id: string;
  scheduled_for: string;
} | null {
  if (!run || !run.input || typeof run.input !== 'object' || Array.isArray(run.input)) return null;
  const parsed = run.input as Record<string, unknown>;
  if (
    !parsed.task ||
    typeof parsed.task !== 'object' ||
    Array.isArray(parsed.task) ||
    typeof parsed.session_id !== 'string' ||
    typeof parsed.scheduled_for !== 'string'
  ) {
    return null;
  }
  return {
    task: normalizeSnapshotTask(parsed.task as Record<string, unknown>),
    session_id: parsed.session_id,
    scheduled_for: parsed.scheduled_for,
  };
}

type RuntimeRun = NonNullable<Awaited<ReturnType<DatabaseProvider['runtime']['getRun']>>>;

/** What the owner is told about a run whose worker died mid-execution. */
export const AUTOMATION_INTERRUPTED_SUMMARY =
  '运行中断：执行这次任务的进程在运行中停止，结果未知。系统不会自动重跑；请打开会话核对下面列出的写入，需要时再手动运行一次。';

function automationOutput(run: RuntimeRun): { summary: string; noUpdate: boolean } {
  if (run.status === 'interrupted') return { summary: AUTOMATION_INTERRUPTED_SUMMARY, noUpdate: false };
  if (run.status !== 'succeeded' || !run.output) {
    return { summary: run.error_message ?? 'Automation execution failed', noUpdate: false };
  }
  if (typeof run.output !== 'object' || Array.isArray(run.output)) return { summary: '', noUpdate: false };
  const output = run.output as { summary?: unknown; no_update?: unknown };
  return {
    summary: typeof output.summary === 'string' ? output.summary : '',
    noUpdate: output.no_update === true,
  };
}

async function projectAutomationOutcome(db: DatabaseProvider, run: RuntimeRun, eventId: string): Promise<void> {
  if (
    run.status !== 'succeeded' &&
    run.status !== 'failed' &&
    run.status !== 'canceled' &&
    run.status !== 'interrupted'
  )
    return;
  const input = automationInput(run);
  if (!input || input.task.id !== run.source_kind.slice(run.source_kind.indexOf(':') + 1)) {
    throw new Error(`Automation Runtime run ${run.id} has invalid immutable input`);
  }
  await db.scheduledTasks.projectRuntimeOutcome({
    runtime_run_id: run.id,
    runtime_version: run.version,
    task_id: input.task.id,
    owner_user_id: run.owner_user_id,
    source_kind: run.source_kind,
    status: run.status,
    scheduled_for: input.scheduled_for,
    run_created_at: run.created_at,
  });
  if (run.status === 'canceled') return;
  const output = automationOutput(run);
  // A quiet automation that found nothing new is kept in history but sends
  // nothing — no inbox row, no webhook, email, WeCom or Feishu delivery.
  if (output.noUpdate) return;
  await notifyTaskResult(
    db,
    input.task,
    {
      status: run.status === 'succeeded' ? 'completed' : run.status === 'interrupted' ? 'interrupted' : 'failed',
      summary: output.summary,
      sessionId: input.session_id,
    },
    {
      runId: run.id,
      eventId,
    },
  );
}

/**
 * Runs inside Runtime's at-least-once Outbox delivery. Throwing keeps the
 * event retryable, so a transient source DB failure cannot leave Runtime and
 * its domain page permanently disagreeing after lease recovery.
 */
export function createRuntimeDomainProjector(db: DatabaseProvider) {
  return async (event: RuntimeEventEnvelope): Promise<void> => {
    if (event.type !== 'run.status_changed' && event.type !== 'run.lease_expired') return;
    const result = record(record(event.payload)?.result);
    if (!result || typeof result.version !== 'number' || typeof result.status !== 'string') return;
    const relevant =
      result.status === 'succeeded' ||
      result.status === 'failed' ||
      result.status === 'canceled' ||
      result.status === 'interrupted' ||
      (result.status === 'queued' && result.error_code === 'runtime_claim_recovered');
    if (!relevant) return;

    const run = await db.runtime.getRun(event.run_id);
    // A delayed recovery event must never overwrite a newer successful retry.
    if (!run || run.version !== result.version || run.status !== result.status) return;
    if (run.status !== 'queued')
      emitExtensionEvent('run.completed', {
        runId: run.id,
        userId: run.owner_user_id,
        kind: run.kind,
        status: run.status,
      });
    if (run.kind === 'chat' && run.status === 'succeeded' && run.session_id)
      emitExtensionEvent('conversation.turn.completed', { conversationId: run.session_id, userId: run.owner_user_id });
    if (run.kind === 'automation') {
      if (run.status === 'failed' || run.status === 'canceled' || run.status === 'interrupted') {
        await reconcileReclaimedAutomationRun(db, run);
      }
      await projectAutomationOutcome(db, run, event.event_id);
      if (run.status !== 'queued')
        emitExtensionEvent('automation.ran', {
          automationId: run.source_kind.slice(run.source_kind.indexOf(':') + 1),
          runId: run.id,
          userId: run.owner_user_id,
          status: run.status,
        });
    }
  };
}
