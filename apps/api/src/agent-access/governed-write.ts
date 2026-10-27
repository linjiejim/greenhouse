import { fromExtensions } from '../plugin-host/index.js';
/**
 * Recorded writes by external agents (MCP).
 *
 * An agent acts as the member it is connected for, with that member's
 * permissions. A write those permissions allow runs at once; the human who
 * confirms it is the one sitting with the agent, in the agent's own client.
 * Greenhouse does not hold writes for approval.
 *
 * Every write becomes one Runtime run (`kind='agent_write'`,
 * `source_kind='proxy_call'`): the audit record behind Settings › Agent
 * connections › Activity and the Execution center, with the exact input and
 * output.
 *
 * Delete-like writes (r3, see risk.ts) take one extra round trip: the first
 * call returns a preview and runs nothing; the agent shows it to its user and
 * calls again with confirm:true. This is a prompt for a human, not a lock.
 *
 * A write whose outcome could not be recorded settles as outcome unknown, never
 * failed, and a run found active at boot is closed the same way and never
 * replayed.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseProvider, RuntimeRunRow, RuntimeStepRow } from '@greenhouse/db';
import {
  canTransitionRuntimeRun,
  canTransitionRuntimeStep,
  RUNTIME_RUN_STATUSES,
  RUNTIME_STEP_STATUSES,
  type RuntimeActionRisk,
  type RuntimePayload,
  type RuntimeRunStatus,
  type RuntimeStepStatus,
} from '@greenhouse/types/runtime';
import {
  AGENT_WRITE_BASES,
  type AgentWriteBasis as WriteBasis,
  type AgentWritePreview,
  type AgentWriteStatus,
  type AgentWriteView,
} from '@greenhouse/types/agent-access';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

import type { ToolRegistry } from '../agent.js';
import { prepareProxyToolCall } from '../agent-runtime/tool-proxy.js';
import { hashToolInput, instrumentRuntimeTools } from '../runtime/tool-evidence.js';
import { countUsage } from '../usage/counters.js';
import { classifyWrite, type WriteClassification } from './risk.js';

export type { AgentWritePreview, AgentWriteStatus, AgentWriteView, WriteBasis };

export const AGENT_WRITE_SOURCE_KIND = 'proxy_call';
const STEP_KEY = 'proxy_call';

export interface WriteCaller {
  /** The member the credential is bound to; owner of the run. */
  userId: string;
  clientId: string;
  clientName: string;
  authMethod: 'oauth' | 'oauth-client';
}

/** What the run's `input` column holds (JSON). */
export interface AgentWriteRunInput {
  version: 1;
  channel: 'mcp';
  client_id: string;
  client_name: string;
  auth_method: WriteCaller['authMethod'];
  tool_id: string;
  action: string | null;
  risk: WriteClassification['risk'];
  input_hash: string;
  input: RuntimePayload;
}

export type GovernedWriteResult =
  | { status: 'executed' | 'failed' | 'outcome_unknown'; view: AgentWriteView }
  | { status: 'needs_confirmation'; preview: AgentWritePreview };

// ─── Run lifecycle helpers ───────────────────────────────

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

interface Finish {
  output?: RuntimePayload;
  errorCode?: string;
  errorMessage?: string;
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'interrupted']);

async function advanceRun(
  db: DatabaseProvider,
  run: RuntimeRunRow,
  target: RuntimeRunStatus,
  actorUserId: string,
  finish: Finish = {},
): Promise<RuntimeRunRow> {
  const path = findPath(run.status, target, RUNTIME_RUN_STATUSES, canTransitionRuntimeRun);
  if (!path) throw new Error(`Agent write ${run.id} cannot move from ${run.status} to ${target}`);
  let current = run;
  for (const status of path) {
    const terminal = TERMINAL.has(status);
    current = await db.runtime.transitionRun({
      id: current.id,
      expected_version: current.version,
      to_status: status,
      idempotency_key: `agent-write:${current.id}:run:${current.version}:${status}`,
      actor_user_id: actorUserId,
      ...(status === 'running' ? { projection_only: true } : {}),
      ...(terminal ? { output: finish.output ?? null, settled_at: new Date().toISOString() } : {}),
      ...(terminal && status !== 'succeeded'
        ? { error_code: finish.errorCode ?? `agent_write_${status}`, error_message: finish.errorMessage ?? status }
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
      idempotency_key: `agent-write:${current.run_id}:step:${current.version}:${status}`,
      actor_user_id: actorUserId,
      ...(status === 'running' ? { projection_only: true } : {}),
      ...(terminal ? { output: finish.output ?? null } : {}),
      ...(terminal && status !== 'succeeded'
        ? { error_code: finish.errorCode ?? `agent_write_${status}`, error_message: finish.errorMessage ?? status }
        : {}),
    });
  }
  return current;
}

function parseInput(run: RuntimeRunRow): AgentWriteRunInput {
  return run.input as AgentWriteRunInput;
}

function parseJson(value: unknown): RuntimePayload | null {
  return value === null || value === undefined ? null : (value as RuntimePayload);
}

function toolError(output: unknown): string | null {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const error = (output as { error?: unknown }).error;
    if (typeof error === 'string' && error.length > 0) return error;
  }
  return null;
}

function statusOf(run: RuntimeRunRow): AgentWriteStatus {
  if (run.status === 'succeeded') return 'executed';
  if (run.status === 'interrupted') return 'outcome_unknown';
  if (run.status === 'failed' || run.status === 'canceled') return 'failed';
  return 'running';
}

/** Timestamps leave as ISO 8601 whatever text form the database returned. */
function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

/**
 * Name the document a write touches, so a person need not decode an id. Only
 * when the member may read it: a record must never reveal the title of a
 * document its owner cannot see. Other targets show their id.
 */
export async function targetLabel(
  db: DatabaseProvider,
  ownerUserId: string,
  toolId: string,
  input: unknown,
): Promise<string | null> {
  const label = fromExtensions('activity')
    .map((entry) => entry.writeLabels?.[toolId])
    .find(Boolean);
  return label ? label(db, ownerUserId, input).catch(() => null) : null;
}

export async function agentWriteView(db: DatabaseProvider, run: RuntimeRunRow): Promise<AgentWriteView> {
  const input = parseInput(run);
  const output = parseJson(run.output);
  const recorded =
    output && typeof output === 'object' && !Array.isArray(output) && typeof output.basis === 'string'
      ? output.basis
      : null;
  return {
    request_id: run.id,
    status: statusOf(run),
    tool_id: input.tool_id,
    action: input.action,
    risk: input.risk,
    client_id: input.client_id,
    client_name: input.client_name,
    avatar: await db.platformOAuth.getUserClientAvatar(run.owner_user_id, input.client_id).catch(() => null),
    basis: AGENT_WRITE_BASES.includes(recorded as WriteBasis) ? (recorded as WriteBasis) : null,
    target_label: await targetLabel(db, run.owner_user_id, input.tool_id, input.input),
    input: input.input,
    output: output && typeof output === 'object' && !Array.isArray(output) ? (output.result ?? null) : null,
    error: run.error_message,
    created_at: iso(run.created_at) ?? run.created_at,
    settled_at: iso(run.settled_at),
  };
}

// ─── Execution ───────────────────────────────────────────

type PreparedCall = ReturnType<typeof prepareProxyToolCall>;

async function executeOnRun(
  db: DatabaseProvider,
  run: RuntimeRunRow,
  step: RuntimeStepRow,
  prepared: PreparedCall,
  registry: ToolRegistry,
  basis: WriteBasis,
): Promise<RuntimeRunRow> {
  countUsage('tool_call', prepared.toolId, 'mcp', () => db);
  const tools = instrumentRuntimeTools(
    { [prepared.toolId]: { ...registry[prepared.toolId], execute: prepared.execute } } as ToolRegistry,
    {
      db,
      runId: run.id,
      stepId: step.id,
      actorUserId: run.owner_user_id,
      executionAuthority: { mode: 'chat_projection' },
      idempotencyPrefix: 'agent-write',
    },
  );
  try {
    const result = await tools[prepared.toolId]!.execute!(prepared.input, {
      toolCallId: `agent-write:${run.id}`,
      messages: [],
    } as never);
    const refusal = toolError(result);
    const output = { basis, result: (result ?? null) as RuntimePayload };
    if (refusal) {
      await advanceStep(db, step, 'failed', run.owner_user_id, {
        output,
        errorCode: 'agent_write_tool_refused',
        errorMessage: refusal,
      });
      return advanceRun(db, run, 'failed', run.owner_user_id, {
        output,
        errorCode: 'agent_write_tool_refused',
        errorMessage: refusal,
      });
    }
    await advanceStep(db, step, 'succeeded', run.owner_user_id, { output });
    return advanceRun(db, run, 'succeeded', run.owner_user_id, { output });
  } catch (error) {
    const message = toErrorMessage(error);
    // The tool ran but its outcome was not recorded (the call is left uncertain,
    // or still running when even that write failed): say so, never "failed",
    // so the agent does not blindly retry.
    const calls = await db.runtime.listToolCalls(run.id);
    const unrecorded = calls.some((call) => ['uncertain', 'running', 'pending'].includes(call.status));
    if (unrecorded) {
      await advanceStep(db, step, 'interrupted', run.owner_user_id, {
        errorCode: 'agent_write_outcome_unknown',
        errorMessage: message,
      });
      return advanceRun(db, run, 'interrupted', run.owner_user_id, {
        output: { basis, result: null },
        errorCode: 'agent_write_outcome_unknown',
        errorMessage: 'The write ran but its result could not be recorded; check the target before retrying',
      });
    }
    await advanceStep(db, step, 'failed', run.owner_user_id, {
      errorCode: 'agent_write_failed',
      errorMessage: message,
    });
    return advanceRun(db, run, 'failed', run.owner_user_id, {
      output: { basis, result: null },
      errorCode: 'agent_write_failed',
      errorMessage: message,
    });
  }
}

async function stepOf(db: DatabaseProvider, runId: string): Promise<RuntimeStepRow> {
  const steps = await db.runtime.listSteps(runId);
  const step = steps.find((candidate) => candidate.step_key === STEP_KEY);
  if (!step) throw new Error(`Agent write ${runId} has no ${STEP_KEY} step`);
  return step;
}

// ─── A new write ─────────────────────────────────────────

export interface GovernWriteOptions {
  db: DatabaseProvider;
  caller: WriteCaller;
  toolId: string;
  /** The tool's arguments, without the protocol-level `confirm` flag. */
  input: unknown;
  registry: ToolRegistry;
  allowedToolIds: string[];
  /** Catalog risk of the tool (`runtime_risk`, else r2 for a proxy write). */
  baseRisk: RuntimeActionRisk;
  /** The agent sent confirm:true (only delete-like writes look at it). */
  confirmed: boolean;
}

export const DELETE_PREVIEW_MESSAGE =
  'Nothing has been deleted yet. Show this to your user and ask whether to go ahead; ' +
  'if they agree, send the same call again with confirm:true.';

export async function governProxyWrite(opts: GovernWriteOptions): Promise<GovernedWriteResult> {
  const { db, caller } = opts;
  // Validate reachability and input before anything is recorded or previewed.
  const prepared = prepareProxyToolCall(opts.registry, opts.toolId, opts.allowedToolIds, opts.input);
  const cls = classifyWrite(prepared.toolId, prepared.input, opts.baseRisk);
  const input = (prepared.input ?? null) as RuntimePayload;

  if (cls.risk === 'r3' && !opts.confirmed) {
    return {
      status: 'needs_confirmation',
      preview: {
        status: 'needs_confirmation',
        tool: prepared.toolId,
        action: cls.action,
        risk: 'r3',
        target: await targetLabel(db, caller.userId, prepared.toolId, prepared.input),
        input,
        message: DELETE_PREVIEW_MESSAGE,
      },
    };
  }

  const runInput: AgentWriteRunInput = {
    version: 1,
    channel: 'mcp',
    client_id: caller.clientId,
    client_name: caller.clientName,
    auth_method: caller.authMethod,
    tool_id: prepared.toolId,
    action: cls.action,
    risk: cls.risk,
    input_hash: hashToolInput({ tool: prepared.toolId, input: prepared.input }),
    input,
  };
  const sourceId = `awr_${randomUUID().replaceAll('-', '')}`;
  const created = await db.runtime.createRun({
    kind: 'agent_write',
    owner_user_id: caller.userId,
    initiated_by_user_id: caller.userId,
    source_kind: AGENT_WRITE_SOURCE_KIND,
    source_id: sourceId,
    idempotency_key: sourceId,
    max_attempts: 1,
    input: runInput as unknown as RuntimePayload,
    actor_user_id: caller.userId,
  });
  let step = await db.runtime.createStep({
    run_id: created.id,
    step_key: STEP_KEY,
    kind: STEP_KEY,
    input: runInput as unknown as RuntimePayload,
    actor_user_id: caller.userId,
    idempotency_key: 'agent-write:step:created',
  });
  const run = await advanceRun(db, created, 'running', caller.userId);
  step = await advanceStep(db, step, 'running', caller.userId);

  const basis: WriteBasis = cls.risk === 'r3' ? 'confirmed' : 'direct';
  const settled = await executeOnRun(db, run, step, prepared, opts.registry, basis);
  const view = await agentWriteView(db, settled);
  return {
    status: view.status === 'executed' ? 'executed' : view.status === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
    view,
  };
}

// ─── Boot reconciliation ─────────────────────────────────

async function* allRuns(db: DatabaseProvider, statuses: RuntimeRunStatus[]): AsyncGenerator<RuntimeRunRow> {
  let cursor: { created_at: string; id: string } | undefined;
  for (;;) {
    const page = await db.runtime.listRuns({ kinds: ['agent_write'], statuses, limit: 100, cursor });
    yield* page.items;
    if (!page.next_cursor) return;
    cursor = page.next_cursor;
  }
}

/**
 * Boot only: a write that was executing when the process stopped may or may
 * not have taken effect. Close it as outcome unknown and never run it again.
 */
export async function reconcileInterruptedAgentWrites(db: DatabaseProvider): Promise<number> {
  let closed = 0;
  for await (const run of allRuns(db, ['queued', 'claimed', 'running'])) {
    try {
      for (const call of await db.runtime.listToolCalls(run.id)) {
        if (call.status !== 'running' && call.status !== 'pending') continue;
        await db.runtime.transitionToolCall({
          id: call.id,
          expected_version: call.version,
          to_status: call.status === 'running' ? 'uncertain' : 'canceled',
          event_idempotency_key: `agent-write:restart:${call.id}:${call.version}`,
          actor_user_id: run.owner_user_id,
          error_code: 'agent_write_process_restarted',
          error_message: 'The API restarted before the write outcome was recorded',
        });
      }
      const step = await stepOf(db, run.id);
      await advanceStep(db, step, 'interrupted', run.owner_user_id, {
        errorCode: 'agent_write_outcome_unknown',
        errorMessage: 'The API restarted while this write was running; it was not retried',
      });
      await advanceRun(db, run, 'interrupted', run.owner_user_id, {
        errorCode: 'agent_write_outcome_unknown',
        errorMessage: 'The API restarted while this write was running; check the target and retry by hand if needed',
      });
      closed++;
    } catch (error) {
      logger.warn('[agent-access] could not reconcile agent write', { run: run.id, error: toErrorMessage(error) });
    }
  }
  return closed;
}
