/** Durable Runtime terminal/recovery event → source-domain repair. */

import type { DatabaseProvider } from '@greenhouse/db';
import type { RuntimeJsonValue } from '@greenhouse/types/runtime';
import { reconcileReclaimedAutomationRun } from '../scheduler/runtime-driver.js';
import { notifyTaskResult } from '../scheduler/notify.js';
import { reconcileReclaimedEvalRun } from './eval-driver.js';
import { reconcileReclaimedSubagentRun } from './subagent-driver.js';
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
  if (!run) return null;
  try {
    const parsed = JSON.parse(run.input) as Record<string, unknown>;
    if (
      !parsed.task ||
      typeof parsed.task !== 'object' ||
      typeof parsed.session_id !== 'string' ||
      typeof parsed.scheduled_for !== 'string'
    ) {
      return null;
    }
    return parsed as unknown as {
      task: Parameters<typeof notifyTaskResult>[1];
      session_id: string;
      scheduled_for: string;
    };
  } catch {
    return null;
  }
}

function automationSummary(run: NonNullable<Awaited<ReturnType<DatabaseProvider['runtime']['getRun']>>>): string {
  if (run.status !== 'succeeded' || !run.output) return run.error_message ?? 'Automation execution failed';
  try {
    const output = JSON.parse(run.output) as { summary?: unknown };
    return typeof output.summary === 'string' ? output.summary : '';
  } catch {
    return '';
  }
}

async function projectAutomationOutcome(
  db: DatabaseProvider,
  run: NonNullable<Awaited<ReturnType<DatabaseProvider['runtime']['getRun']>>>,
  eventId: string,
): Promise<void> {
  if (run.status !== 'succeeded' && run.status !== 'failed' && run.status !== 'canceled') return;
  const input = automationInput(run);
  if (!input || input.task.id !== Number(run.source_kind.split(':')[1])) {
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
  await notifyTaskResult(
    db,
    input.task,
    {
      status: run.status === 'succeeded' ? 'completed' : 'failed',
      summary: automationSummary(run),
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
      (result.status === 'queued' && result.error_code === 'runtime_claim_recovered');
    if (!relevant) return;

    const run = await db.runtime.getRun(event.run_id);
    // A delayed recovery event must never overwrite a newer successful retry.
    if (!run || run.version !== result.version || run.status !== result.status) return;
    if (run.kind === 'eval') await reconcileReclaimedEvalRun(db, run);
    else if (run.kind === 'automation') {
      if (run.status === 'failed' || run.status === 'canceled') await reconcileReclaimedAutomationRun(db, run);
      await projectAutomationOutcome(db, run, event.event_id);
    } else if (run.kind === 'subagent') await reconcileReclaimedSubagentRun(db, run);
  };
}
