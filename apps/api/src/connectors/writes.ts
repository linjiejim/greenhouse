/**
 * Recorded connector writes — every non-read-only `mcp_call` that runs.
 *
 * One Runtime run per write (`kind='connector_write'`,
 * `source_kind='connector_call'`), owned by the member whose agent made it:
 * the record behind 操作记录 and the Execution center. The input keeps the
 * connector, tool and arguments; the output keeps a short excerpt of the
 * remote answer. No ToolCall rows: the remote side is not a Greenhouse tool
 * and has no replay semantics — a write found running at boot is closed as
 * outcome unknown and never run again.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseProvider, RuntimeRunRow, RuntimeStepRow } from '@greenhouse/db';
import type { ConnectorToolKind } from '@greenhouse/types/connectors';
import {
  canTransitionRuntimeRun,
  canTransitionRuntimeStep,
  RUNTIME_RUN_STATUSES,
  RUNTIME_STEP_STATUSES,
  type RuntimePayload,
  type RuntimeRunStatus,
  type RuntimeStepStatus,
} from '@greenhouse/types/runtime';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

export const CONNECTOR_WRITE_SOURCE_KIND = 'connector_call';
const STEP_KEY = 'connector_call';
/** Characters of the remote answer kept on the record. */
const OUTPUT_EXCERPT_MAX = 2000;

/** Where the write came from. */
export type ConnectorWriteOrigin = 'chat' | 'automation' | 'mcp';

/** What the run's `input` column holds (JSON). */
export interface ConnectorWriteRunInput {
  version: 1;
  origin: ConnectorWriteOrigin;
  connector_id: string;
  connector: string;
  connector_name: string;
  tool: string;
  kind: ConnectorToolKind;
  /** `confirmed` = a destructive tool the user approved on a preview. */
  basis: 'direct' | 'confirmed';
  arguments: RuntimePayload;
  /** The external agent (mcp origin). */
  client_name?: string | null;
}

function findPath<S extends string>(from: S, to: S, all: readonly S[], can: (a: S, b: S) => boolean): S[] | null {
  if (from === to) return [];
  const queue: Array<{ status: S; path: S[] }> = [{ status: from, path: [] }];
  const seen = new Set<S>([from]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of all) {
      if (seen.has(next) || !can(current.status, next)) continue;
      const path = [...current.path, next];
      if (next === to) return path;
      seen.add(next);
      queue.push({ status: next, path });
    }
  }
  return null;
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);

interface Finish {
  output?: RuntimePayload;
  errorCode?: string;
  errorMessage?: string;
}

async function advanceRun(
  db: DatabaseProvider,
  run: RuntimeRunRow,
  target: RuntimeRunStatus,
  finish: Finish = {},
): Promise<RuntimeRunRow> {
  const path = findPath(run.status, target, RUNTIME_RUN_STATUSES, canTransitionRuntimeRun);
  if (!path) throw new Error(`Connector write ${run.id} cannot move from ${run.status} to ${target}`);
  let current = run;
  for (const status of path) {
    const terminal = TERMINAL.has(status);
    current = await db.runtime.transitionRun({
      id: current.id,
      expected_version: current.version,
      to_status: status,
      idempotency_key: `connector-write:${current.id}:run:${current.version}:${status}`,
      actor_user_id: run.owner_user_id,
      ...(status === 'running' ? { projection_only: true } : {}),
      ...(terminal ? { output: finish.output ?? null, settled_at: new Date().toISOString() } : {}),
      ...(terminal && status !== 'succeeded'
        ? {
            error_code: finish.errorCode ?? `connector_write_${status}`,
            error_message: finish.errorMessage ?? status,
          }
        : {}),
    });
  }
  return current;
}

async function advanceStep(
  db: DatabaseProvider,
  step: RuntimeStepRow,
  target: RuntimeStepStatus,
  actorUserId: string,
  finish: Finish = {},
): Promise<RuntimeStepRow> {
  if (TERMINAL.has(step.status) && step.status !== target) return step;
  const path = findPath(step.status, target, RUNTIME_STEP_STATUSES, canTransitionRuntimeStep);
  if (!path) return step;
  let current = step;
  for (const status of path) {
    const terminal = TERMINAL.has(status);
    current = await db.runtime.transitionStep({
      id: current.id,
      expected_version: current.version,
      to_status: status,
      idempotency_key: `connector-write:${current.run_id}:step:${current.version}:${status}`,
      actor_user_id: actorUserId,
      ...(status === 'running' ? { projection_only: true } : {}),
      ...(terminal ? { output: finish.output ?? null } : {}),
      ...(terminal && status !== 'succeeded'
        ? {
            error_code: finish.errorCode ?? `connector_write_${status}`,
            error_message: finish.errorMessage ?? status,
          }
        : {}),
    });
  }
  return current;
}

export interface ConnectorWriteHandle {
  run: RuntimeRunRow;
  step: RuntimeStepRow;
}

/** Record a write about to run. */
export async function beginConnectorWrite(
  db: DatabaseProvider,
  input: { ownerUserId: string; sessionId?: string | null } & Omit<ConnectorWriteRunInput, 'version'>,
): Promise<ConnectorWriteHandle> {
  const { ownerUserId, sessionId, ...rest } = input;
  const runInput: ConnectorWriteRunInput = { version: 1, ...rest };
  const sourceId = `cwr_${randomUUID().replaceAll('-', '')}`;
  const created = await db.runtime.createRun({
    kind: 'connector_write',
    owner_user_id: ownerUserId,
    initiated_by_user_id: ownerUserId,
    session_id: sessionId ?? null,
    source_kind: CONNECTOR_WRITE_SOURCE_KIND,
    source_id: sourceId,
    idempotency_key: sourceId,
    max_attempts: 1,
    input: runInput as unknown as RuntimePayload,
    actor_user_id: ownerUserId,
  });
  let step = await db.runtime.createStep({
    run_id: created.id,
    step_key: STEP_KEY,
    kind: STEP_KEY,
    input: runInput as unknown as RuntimePayload,
    actor_user_id: ownerUserId,
    idempotency_key: 'connector-write:step:created',
  });
  const run = await advanceRun(db, created, 'running');
  step = await advanceStep(db, step, 'running', ownerUserId);
  return { run, step };
}

/** Settle a recorded write with what the remote side answered. Never throws. */
export async function finishConnectorWrite(
  db: DatabaseProvider,
  handle: ConnectorWriteHandle,
  outcome: { ok: true; text: string } | { ok: false; error: string; unknown?: boolean },
): Promise<void> {
  const owner = handle.run.owner_user_id;
  try {
    if (outcome.ok) {
      const output = { result: outcome.text.slice(0, OUTPUT_EXCERPT_MAX) };
      await advanceStep(db, handle.step, 'succeeded', owner, { output });
      await advanceRun(db, handle.run, 'succeeded', { output });
      return;
    }
    const target = outcome.unknown ? 'interrupted' : 'failed';
    const finish = {
      output: { result: null },
      errorCode: outcome.unknown ? 'connector_write_outcome_unknown' : 'connector_write_failed',
      errorMessage: outcome.error.slice(0, 1000),
    };
    await advanceStep(db, handle.step, target, owner, finish);
    await advanceRun(db, handle.run, target, finish);
  } catch (error) {
    logger.warn('[connectors] could not settle a connector write', {
      run: handle.run.id,
      error: toErrorMessage(error),
    });
  }
}

/**
 * Boot only: a write that was running when the process stopped may or may not
 * have reached the remote system. Close it as outcome unknown, never re-run it.
 */
export async function reconcileInterruptedConnectorWrites(db: DatabaseProvider): Promise<number> {
  let closed = 0;
  let cursor: { created_at: string; id: string } | undefined;
  for (;;) {
    const page = await db.runtime.listRuns({
      kinds: ['connector_write'],
      statuses: ['queued', 'claimed', 'running'],
      limit: 100,
      cursor,
    });
    for (const run of page.items) {
      try {
        const step = (await db.runtime.listSteps(run.id)).find((s) => s.step_key === STEP_KEY);
        const finish = {
          errorCode: 'connector_write_outcome_unknown',
          errorMessage: 'The API restarted while this write was running; check the other system before retrying',
        };
        if (step) await advanceStep(db, step, 'interrupted', run.owner_user_id, finish);
        await advanceRun(db, run, 'interrupted', finish);
        closed++;
      } catch (error) {
        logger.warn('[connectors] could not reconcile a connector write', {
          run: run.id,
          error: toErrorMessage(error),
        });
      }
    }
    if (!page.next_cursor) return closed;
    cursor = page.next_cursor;
  }
}
