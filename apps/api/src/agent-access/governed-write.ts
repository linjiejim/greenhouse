/**
 * Governed writes by external agents (MCP).
 *
 * Every write an external agent makes for a member becomes one Runtime run
 * (`kind='agent_write'`, `source_kind='proxy_call'`). The run is the audit
 * record and, when the write needs a human, the approval request:
 *
 *   r1, or r2 covered by a standing grant, or r2 + legacy confirm:true
 *       → run now; the run records the basis and the exact output.
 *   anything else
 *       → the run waits on a `mutation_approval` interrupt assigned to the
 *         member; the agent gets `needs_approval` and polls the request.
 *
 * A decision runs the write at most once: the interrupt CAS (pending →
 * resolved) and then the run CAS (waiting → running) each have one winner.
 * Before running, the identity is re-derived from the CURRENT OAuth grant, so a
 * revoked client or narrowed scope stops an approved write. A run found active
 * at boot is closed as outcome unknown and never replayed.
 */

import { randomUUID } from 'node:crypto';
import {
  RuntimeKernelError,
  type DatabaseProvider,
  type RuntimeInterruptRow,
  type RuntimeRunRow,
  type RuntimeStepRow,
} from '@greenhouse/db';
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
import type { AgentWriteBasis as WriteBasis, AgentWriteStatus, AgentWriteView } from '@greenhouse/types/agent-access';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

import type { ToolRegistry } from '../agent.js';
import { prepareProxyToolCall } from '../agent-runtime/tool-proxy.js';
import { hashToolInput, instrumentRuntimeTools } from '../runtime/tool-evidence.js';
import { countUsage } from '../usage/counters.js';
import { canRead as canReadKb, resolveKbAccess } from '../knowledge/access.js';
import { classifyWrite, type WriteClassification } from './risk.js';

export type { AgentWriteStatus, AgentWriteView, WriteBasis };

export const AGENT_WRITE_SOURCE_KIND = 'proxy_call';
const STEP_KEY = 'proxy_call';
/** How long a request waits for the member before it expires. */
export const AGENT_WRITE_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** Longest an agent may block on `agent_write_status` in one call. */
export const AGENT_WRITE_MAX_WAIT_SECONDS = 30;

export interface WriteCaller {
  /** The member the credential is bound to; owner of the run. */
  userId: string;
  clientId: string;
  clientName: string;
  authMethod: 'oauth' | 'oauth-client';
  /** Who decides when approval is needed (the member, or a machine client's creator). */
  approverUserId: string;
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
  target_key: string | null;
  input_hash: string;
  input: RuntimePayload;
}

export type GovernedWriteResult =
  | { status: 'executed' | 'failed'; view: AgentWriteView }
  | { status: 'needs_approval'; view: AgentWriteView; reused: boolean };

export class AgentWriteError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'not_pending' | 'no_longer_permitted' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'AgentWriteError';
  }
}

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
  waitReason?: string;
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
  if (!path)
    throw new AgentWriteError('not_pending', `Agent write ${run.id} cannot move from ${run.status} to ${target}`);
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
      ...(status === 'waiting' ? { wait_reason: finish.waitReason ?? 'approval' } : {}),
      ...(status === 'canceled' ? { desired_state: 'cancel' as const } : {}),
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
  return JSON.parse(run.input) as AgentWriteRunInput;
}

function parseJson(text: string | null): RuntimePayload | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as RuntimePayload;
  } catch {
    return text;
  }
}

function toolError(output: unknown): string | null {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const error = (output as { error?: unknown }).error;
    if (typeof error === 'string' && error.length > 0) return error;
  }
  return null;
}

function statusOf(run: RuntimeRunRow, interrupt: RuntimeInterruptRow | undefined): AgentWriteStatus {
  if (run.status === 'waiting') {
    // The interrupt settles a moment before the run moves: report where the
    // request is going, and keep pollers polling until the run lands.
    if (!interrupt || interrupt.status === 'pending') return 'pending';
    if (interrupt.status === 'rejected') return 'rejected';
    if (interrupt.status === 'expired') return 'expired';
    return 'running';
  }
  if (run.status === 'succeeded') return 'executed';
  if (run.status === 'failed') return 'failed';
  if (run.status === 'interrupted') return 'outcome_unknown';
  if (run.status === 'canceled') {
    const code = run.error_code ?? '';
    if (code === 'agent_write_rejected') return 'rejected';
    if (code === 'agent_write_superseded') return 'superseded';
    if (code === 'agent_write_withdrawn') return 'withdrawn';
    if (code === 'agent_write_approval_lost') return 'failed';
    return 'expired';
  }
  return 'running';
}

/** Timestamps leave as ISO 8601 whatever text form the database returned. */
function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

/**
 * Name the document a write touches, so the approver need not decode an id.
 * Only when the requesting member may read it: a request must never reveal the
 * title of a record its owner cannot see. Other targets show their id.
 */
async function targetLabel(
  db: DatabaseProvider,
  ownerUserId: string,
  toolId: string,
  input: unknown,
): Promise<string | null> {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  if (!toolId.startsWith('knowledge_') || typeof args.doc_id !== 'string' || !args.doc_id) return null;
  try {
    const doc = await db.knowledgeBase.get(args.doc_id, 'shared');
    if (!doc || !canReadKb(await resolveKbAccess(db, doc, ownerUserId))) return null;
    return doc.title;
  } catch {
    // A label is a convenience; the input itself is always shown.
    return null;
  }
}

export async function agentWriteView(db: DatabaseProvider, run: RuntimeRunRow): Promise<AgentWriteView> {
  const input = parseInput(run);
  const interrupts = await db.runtime.listInterrupts(run.id);
  const interrupt = interrupts.at(-1);
  const output = parseJson(run.output);
  const basis =
    output && typeof output === 'object' && !Array.isArray(output) && typeof output.basis === 'string'
      ? (output.basis as WriteBasis)
      : null;
  return {
    request_id: run.id,
    status: statusOf(run, interrupt),
    tool_id: input.tool_id,
    action: input.action,
    risk: input.risk,
    client_id: input.client_id,
    client_name: input.client_name,
    basis,
    target_label: await targetLabel(db, run.owner_user_id, input.tool_id, input.input),
    input: input.input,
    output: output && typeof output === 'object' && !Array.isArray(output) ? (output.result ?? null) : null,
    error: run.error_message,
    created_at: iso(run.created_at) ?? run.created_at,
    settled_at: iso(run.settled_at),
    expires_at: iso(interrupt?.expires_at),
    interrupt_id: interrupt?.id ?? null,
    decided_by_user_id: interrupt?.decided_by_user_id ?? null,
  };
}

// ─── Execution ───────────────────────────────────────────

async function executeOnRun(
  db: DatabaseProvider,
  run: RuntimeRunRow,
  step: RuntimeStepRow,
  registry: ToolRegistry,
  allowedToolIds: string[],
  basis: WriteBasis,
): Promise<RuntimeRunRow> {
  const input = parseInput(run);
  let prepared;
  try {
    prepared = prepareProxyToolCall(registry, input.tool_id, allowedToolIds, input.input);
  } catch (error) {
    const message = toErrorMessage(error);
    await advanceStep(db, step, 'failed', run.owner_user_id, {
      errorCode: 'agent_write_no_longer_permitted',
      errorMessage: message,
    });
    return advanceRun(db, run, 'failed', run.owner_user_id, {
      output: { basis, result: null },
      errorCode: 'agent_write_no_longer_permitted',
      errorMessage: message,
    });
  }
  // Counted where it actually runs: a held request counts once, when approved.
  countUsage('tool_call', prepared.toolId, 'mcp', () => db);
  // Set once admission let THIS executor into the tool: from then on a failure
  // is ours to settle, never "someone else's running call".
  let entered = false;
  const execute: typeof prepared.execute = (...args) => {
    entered = true;
    return prepared.execute(...args);
  };
  const tools = instrumentRuntimeTools(
    { [prepared.toolId]: { ...registry[prepared.toolId], execute } } as ToolRegistry,
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
    const calls = await db.runtime.listToolCalls(run.id);
    // Refused at admission while another executor holds the call: it settles the run, not us.
    if (!entered && calls.some((call) => call.status === 'running' || call.status === 'pending')) {
      return (await db.runtime.getRun(run.id)) ?? run;
    }
    // Our tool ran but its outcome was not recorded (the call is left uncertain,
    // or still running when even that write failed): say so, never "failed",
    // so the agent does not blindly retry.
    const unrecorded = (call: { status: string }) =>
      call.status === 'uncertain' || (entered && (call.status === 'running' || call.status === 'pending'));
    if (calls.some(unrecorded)) {
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

/**
 * Settle one approval interrupt. Every call carries its own idempotency key, so
 * a concurrent duplicate fails on the version instead of replaying the
 * winner's result and entering execution a second time.
 */
async function settleInterrupt(
  db: DatabaseProvider,
  interrupt: RuntimeInterruptRow,
  type: 'resolve' | 'reject' | 'cancel',
  decision: Record<string, unknown>,
  actorUserId: string,
): Promise<void> {
  try {
    await db.runtime.commandInterrupt(
      {
        type,
        interrupt_id: interrupt.id,
        expected_version: interrupt.version,
        idempotency_key: `agent-write:${interrupt.id}:${type}:${randomUUID()}`,
        decision: decision as never,
      },
      actorUserId,
    );
  } catch (error) {
    if (
      error instanceof RuntimeKernelError &&
      (error.code === 'runtime_version_conflict' || error.code === 'runtime_invalid_transition')
    ) {
      throw new AgentWriteError('not_pending', 'This request has already been decided or has expired');
    }
    throw error;
  }
}

async function stepOf(db: DatabaseProvider, runId: string): Promise<RuntimeStepRow> {
  const steps = await db.runtime.listSteps(runId);
  const step = steps.find((candidate) => candidate.step_key === STEP_KEY);
  if (!step) throw new Error(`Agent write ${runId} has no ${STEP_KEY} step`);
  return step;
}

// ─── Governing a new write ───────────────────────────────

export interface GovernWriteOptions {
  db: DatabaseProvider;
  caller: WriteCaller;
  toolId: string;
  input: unknown;
  registry: ToolRegistry;
  allowedToolIds: string[];
  /** Catalog risk of the tool (`runtime_risk`, else r2 for a proxy write). */
  baseRisk: RuntimeActionRisk;
  /** The agent passed confirm:true and the workspace still honours it. */
  legacyConfirm: boolean;
}

export async function governProxyWrite(opts: GovernWriteOptions): Promise<GovernedWriteResult> {
  const { db, caller } = opts;
  // Validate reachability and input before anything is recorded.
  const prepared = prepareProxyToolCall(opts.registry, opts.toolId, opts.allowedToolIds, opts.input);
  const cls = classifyWrite(prepared.toolId, prepared.input, opts.baseRisk);
  const inputHash = hashToolInput({ tool: prepared.toolId, input: prepared.input });

  let basis: WriteBasis | null = null;
  let grantId: string | null = null;
  if (cls.risk === 'r1') basis = 'own_reversible';
  else if (cls.risk === 'r2') {
    const grant = await db.agentWriteGrants.findCovering({
      user_id: caller.userId,
      client_id: caller.clientId,
      tool_id: prepared.toolId,
      action: cls.action,
    });
    if (grant) {
      basis = 'standing_grant';
      grantId = grant.id;
    } else if (opts.legacyConfirm) basis = 'legacy_confirm';
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
    target_key: cls.targetKey,
    input_hash: inputHash,
    input: (prepared.input ?? null) as RuntimePayload,
  };

  if (!basis) {
    // The same request repeated while it is still waiting: hand back the original.
    const waiting = await db.runtime.listRuns({
      owner_user_id: caller.userId,
      kinds: ['agent_write'],
      statuses: ['waiting'],
      limit: 100,
    });
    for (const candidate of waiting.items) {
      const candidateInput = parseInput(candidate);
      if (candidateInput.client_id === caller.clientId && candidateInput.input_hash === inputHash) {
        return { status: 'needs_approval', view: await agentWriteView(db, candidate), reused: true };
      }
    }
    // A newer request for the same target replaces an older one still waiting.
    if (cls.targetKey) {
      for (const candidate of waiting.items) {
        const candidateInput = parseInput(candidate);
        if (candidateInput.client_id === caller.clientId && candidateInput.target_key === cls.targetKey) {
          // An older request approved meanwhile stands; the new one waits on its own.
          await closeWaiting(db, candidate, 'superseded', caller.userId).catch((error: unknown) => {
            if (!(error instanceof AgentWriteError)) throw error;
          });
        }
      }
    }
  }

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
  let run = await advanceRun(db, created, 'running', caller.userId);
  step = await advanceStep(db, step, 'running', caller.userId);

  if (basis) {
    if (grantId) await db.agentWriteGrants.recordUse(grantId);
    run = await executeOnRun(db, run, step, opts.registry, opts.allowedToolIds, basis);
    const view = await agentWriteView(db, run);
    return { status: view.status === 'executed' ? 'executed' : 'failed', view };
  }

  run = await advanceRun(db, run, 'waiting', caller.userId, { waitReason: 'approval' });
  step = await advanceStep(db, step, 'waiting', caller.userId);
  await db.runtime.createInterrupt({
    run_id: run.id,
    step_id: step.id,
    kind: 'mutation_approval',
    payload: {
      kind: 'agent_write',
      tool_id: prepared.toolId,
      action: cls.action,
      client_id: caller.clientId,
      client_name: caller.clientName,
      input: runInput.input,
    },
    canonical_input_hash: inputHash,
    risk_level: cls.risk,
    assignee_user_id: caller.approverUserId,
    expires_at: new Date(Date.now() + AGENT_WRITE_APPROVAL_TTL_MS).toISOString(),
    actor_user_id: caller.userId,
    idempotency_key: `agent-write:${run.id}:interrupt`,
  });
  return { status: 'needs_approval', view: await agentWriteView(db, run), reused: false };
}

// ─── Closing a waiting request ───────────────────────────

type CloseReason = 'rejected' | 'superseded' | 'withdrawn' | 'expired';

async function closeWaiting(
  db: DatabaseProvider,
  run: RuntimeRunRow,
  reason: CloseReason,
  actorUserId: string,
): Promise<RuntimeRunRow> {
  const interrupts = await db.runtime.listInterrupts(run.id);
  const now = Date.now();
  for (const interrupt of interrupts) {
    if (interrupt.status !== 'pending') continue;
    // Past its expiry the kernel refuses every command; it can no longer be approved either.
    if (interrupt.expires_at && Date.parse(interrupt.expires_at) <= now) continue;
    // Losing this race to an approval must not cancel the run under it.
    await settleInterrupt(
      db,
      interrupt,
      reason === 'rejected' ? 'reject' : 'cancel',
      { decision: reason },
      actorUserId,
    );
  }
  if (interrupts.some((interrupt) => interrupt.status === 'resolved')) {
    throw new AgentWriteError('not_pending', 'This request was already approved');
  }
  const step = await stepOf(db, run.id);
  const message =
    reason === 'rejected'
      ? 'The member rejected this write'
      : reason === 'superseded'
        ? 'A newer request for the same target replaced this one'
        : reason === 'withdrawn'
          ? 'The agent withdrew this request'
          : 'Nobody approved this write before it expired';
  await advanceStep(db, step, 'canceled', actorUserId, { errorCode: `agent_write_${reason}`, errorMessage: message });
  return advanceRun(db, run, 'canceled', actorUserId, { errorCode: `agent_write_${reason}`, errorMessage: message });
}

// ─── Deciding ────────────────────────────────────────────

export interface DecideOptions {
  db: DatabaseProvider;
  interruptId: string;
  actor: { id: string; role: string };
  decision: 'approve' | 'reject';
  /** Approve and also allow this tool/action for this client for N days (r2 only). */
  grantDays?: 1 | 7 | 30 | 90;
  /**
   * Rebuilds what the agent may do NOW from the current grant: returns the
   * registry and reachable tool ids, or a reason it is no longer permitted.
   */
  resolveContext: (
    run: RuntimeRunRow,
    input: AgentWriteRunInput,
  ) => Promise<{ ok: true; registry: ToolRegistry; toolIds: string[] } | { ok: false; reason: string }>;
}

export async function decideAgentWrite(opts: DecideOptions): Promise<AgentWriteView> {
  const { db } = opts;
  const interrupt = await db.runtime.getInterrupt(opts.interruptId);
  if (!interrupt) throw new AgentWriteError('not_found', 'Approval request not found');
  const run = await db.runtime.getRun(interrupt.run_id);
  if (!run || run.kind !== 'agent_write') throw new AgentWriteError('not_found', 'Approval request not found');
  if (interrupt.assignee_user_id !== opts.actor.id && opts.actor.role !== 'super') {
    throw new AgentWriteError('forbidden', 'Only the member who owns this agent can decide');
  }
  if (interrupt.status !== 'pending' || run.status !== 'waiting') {
    throw new AgentWriteError('not_pending', 'This request has already been decided or has expired');
  }
  const input = parseInput(run);

  if (opts.decision === 'reject') {
    // closeWaiting rejects the pending interrupt itself (one CAS, one winner).
    const closed = await closeWaiting(db, run, 'rejected', opts.actor.id);
    return agentWriteView(db, closed);
  }

  if (opts.grantDays !== undefined && input.risk !== 'r2') {
    throw new AgentWriteError('invalid', 'Only shared-data (r2) writes can be allowed in advance');
  }
  // One winner: a second approver (even the same member, twice) fails here.
  await settleInterrupt(
    db,
    interrupt,
    'resolve',
    { decision: 'approve', ...(opts.grantDays ? { grant_days: opts.grantDays } : {}) },
    opts.actor.id,
  );
  let current = await advanceRun(db, run, 'running', opts.actor.id);
  let step = await stepOf(db, run.id);
  step = await advanceStep(db, step, 'running', opts.actor.id);

  const context = await opts.resolveContext(current, input);
  if (!context.ok) {
    await advanceStep(db, step, 'failed', opts.actor.id, {
      errorCode: 'agent_write_no_longer_permitted',
      errorMessage: context.reason,
    });
    current = await advanceRun(db, current, 'failed', opts.actor.id, {
      output: { basis: 'approved', result: null },
      errorCode: 'agent_write_no_longer_permitted',
      errorMessage: context.reason,
    });
    return agentWriteView(db, current);
  }
  current = await executeOnRun(db, current, step, context.registry, context.toolIds, 'approved');
  if (opts.grantDays && current.status === 'succeeded') {
    await db.agentWriteGrants.create({
      user_id: run.owner_user_id,
      client_id: input.client_id,
      tool_id: input.tool_id,
      action: input.action,
      days: opts.grantDays,
      created_via: 'approval',
    });
  }
  return agentWriteView(db, current);
}

// ─── The calling agent's view ────────────────────────────

async function callerRun(db: DatabaseProvider, requestId: string, caller: Pick<WriteCaller, 'userId' | 'clientId'>) {
  const run = await db.runtime.getRun(requestId);
  if (
    !run ||
    run.kind !== 'agent_write' ||
    run.owner_user_id !== caller.userId ||
    parseInput(run).client_id !== caller.clientId
  ) {
    throw new AgentWriteError('not_found', 'No such request for this agent');
  }
  return run;
}

/** Status for the agent that made the request, optionally waiting for a decision. */
export async function agentWriteStatus(
  db: DatabaseProvider,
  requestId: string,
  caller: Pick<WriteCaller, 'userId' | 'clientId'>,
  waitSeconds = 0,
): Promise<AgentWriteView> {
  const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), AGENT_WRITE_MAX_WAIT_SECONDS) * 1000;
  for (;;) {
    const run = await callerRun(db, requestId, caller);
    const view = await agentWriteView(db, run);
    if ((view.status !== 'pending' && view.status !== 'running') || Date.now() >= deadline) return view;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function withdrawAgentWrite(
  db: DatabaseProvider,
  requestId: string,
  caller: Pick<WriteCaller, 'userId' | 'clientId'>,
): Promise<AgentWriteView> {
  const run = await callerRun(db, requestId, caller);
  if (run.status !== 'waiting')
    throw new AgentWriteError('not_pending', 'Only a request still waiting can be withdrawn');
  return agentWriteView(db, await closeWaiting(db, run, 'withdrawn', caller.userId));
}

// ─── Sweeps ──────────────────────────────────────────────

/** Close waiting requests whose approval expired. Safe to run often. */
async function* allRuns(db: DatabaseProvider, statuses: RuntimeRunStatus[]): AsyncGenerator<RuntimeRunRow> {
  let cursor: { created_at: string; id: string } | undefined;
  for (;;) {
    const page = await db.runtime.listRuns({ kinds: ['agent_write'], statuses, limit: 100, cursor });
    yield* page.items;
    if (!page.next_cursor) return;
    cursor = page.next_cursor;
  }
}

const APPROVAL_IN_FLIGHT_MS = 10 * 60_000;

export async function sweepExpiredAgentWrites(db: DatabaseProvider): Promise<number> {
  let closed = 0;
  const now = Date.now();
  for await (const run of allRuns(db, ['waiting'])) {
    const interrupts = await db.runtime.listInterrupts(run.id);
    const live = interrupts.find(
      (interrupt) =>
        interrupt.status === 'pending' && (!interrupt.expires_at || Date.parse(interrupt.expires_at) > now),
    );
    if (live) continue;
    try {
      const approved = interrupts.find((interrupt) => interrupt.status === 'resolved');
      if (approved) {
        // Approved but never started: an approval in flight, or one whose process
        // stopped before the write began. Give it time, then close it unrun.
        if (now - Date.parse(approved.updated_at) < APPROVAL_IN_FLIGHT_MS) continue;
        const message = 'Approved, but the server stopped before the write started; it was not run';
        await advanceStep(db, await stepOf(db, run.id), 'canceled', run.owner_user_id, {
          errorCode: 'agent_write_approval_lost',
          errorMessage: message,
        });
        await advanceRun(db, run, 'canceled', run.owner_user_id, {
          errorCode: 'agent_write_approval_lost',
          errorMessage: message,
        });
      } else {
        await closeWaiting(db, run, 'expired', run.owner_user_id);
      }
      closed++;
    } catch (error) {
      logger.warn('[agent-access] could not expire agent write', { run: run.id, error: toErrorMessage(error) });
    }
  }
  return closed;
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
