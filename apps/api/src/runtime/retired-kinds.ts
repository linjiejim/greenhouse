/**
 * Runtime runs whose producing module was removed: Evaluation, Missions and
 * Workflows in v1.4, sub-sessions (`spawn_session` → `subagent`) in 1.5.
 *
 * Nothing will ever drive these runs again, so a run that was still active at
 * upgrade time is closed once at boot: its pending interrupts are canceled, its
 * open tool calls are closed (a call already running is marked `uncertain`, never
 * replayed), open steps and the run itself become `canceled` with
 * `runtime_kind_retired`, and no notification is sent. The history stays readable (read-only) in the
 * Execution center; the run kinds themselves stay in the Runtime contract.
 */

import type { DatabaseProvider, RuntimeRunRow } from '@greenhouse/db';
import type { RuntimeRunKind, RuntimeRunStatus, RuntimeStepStatus } from '@greenhouse/types/runtime';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { nowIso } from '@greenhouse/utils/date';
import { settleOpenRuntimeToolCalls } from './tool-evidence.js';

export const RETIRED_RUNTIME_KINDS = [
  'eval',
  'mission',
  'workflow',
  'subagent',
] as const satisfies readonly RuntimeRunKind[];

const ACTIVE_RUN_STATUSES: readonly RuntimeRunStatus[] = ['queued', 'claimed', 'running', 'waiting', 'paused'];
const OPEN_STEP_STATUSES: readonly RuntimeStepStatus[] = ['queued', 'claimed', 'running', 'waiting', 'paused'];
const REASON = 'runtime_kind_retired';
const MESSAGE = 'This kind of run was retired; it can no longer make progress.';

async function settleRun(db: DatabaseProvider, run: RuntimeRunRow): Promise<void> {
  for (const interrupt of await db.runtime.listInterrupts(run.id)) {
    if (interrupt.status !== 'pending') continue;
    // An already-lapsed interrupt is left to the normal expiry sweep.
    if (interrupt.expires_at && Date.parse(interrupt.expires_at) <= Date.now()) continue;
    await db.runtime.commandInterrupt(
      {
        type: 'cancel',
        interrupt_id: interrupt.id,
        expected_version: interrupt.version,
        idempotency_key: `${REASON}:interrupt:${interrupt.id}`,
        decision: { reason: REASON },
      },
      run.owner_user_id,
    );
  }
  await settleOpenRuntimeToolCalls(db, run.id, 'canceled', run.owner_user_id);
  for (const step of await db.runtime.listSteps(run.id)) {
    if (!OPEN_STEP_STATUSES.includes(step.status)) continue;
    await db.runtime.transitionStep({
      id: step.id,
      expected_version: step.version,
      to_status: 'canceled',
      idempotency_key: `${REASON}:step:${step.id}`,
      error_code: REASON,
      error_message: MESSAGE,
    });
  }
  const current = await db.runtime.getRun(run.id);
  if (!current || !ACTIVE_RUN_STATUSES.includes(current.status)) return;
  await db.runtime.transitionRun({
    id: current.id,
    expected_version: current.version,
    to_status: 'canceled',
    desired_state: 'cancel',
    idempotency_key: `${REASON}:run:${current.id}`,
    error_code: REASON,
    error_message: MESSAGE,
    settled_at: nowIso(),
    suppress_notification: true,
  });
}

/** Close every still-active run of a retired kind. Each failure is isolated and retried next boot. */
export async function settleRetiredRuntimeRuns(db: DatabaseProvider): Promise<number> {
  let cursor: { created_at: string; id: string } | undefined;
  let settled = 0;
  do {
    const page = await db.runtime.listRuns({
      kinds: RETIRED_RUNTIME_KINDS,
      statuses: ACTIVE_RUN_STATUSES,
      cursor,
      limit: 100,
    });
    for (const run of page.items) {
      try {
        await settleRun(db, run);
        settled += 1;
      } catch (error) {
        logger.warn('[runtime] could not settle a run of a retired kind', {
          runtimeRunId: run.id,
          kind: run.kind,
          error: toErrorMessage(error),
        });
      }
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return settled;
}
