/**
 * Run driver — the deterministic scheduler around agent nodes.
 *
 * `driveRun` is idempotent and re-entrant: every iteration recomputes the
 * ready set from DB rows (the rows ARE the checkpoints), launches what fits
 * the concurrency budget, and pauses the run when only human gates remain.
 * Crash → boot sweep (`resumeActiveRuns`) fails stranded 'running' rows and
 * simply drives again; gate decisions (`applyGateDecision`) mutate rows and
 * the caller drives again. Back-and-forth is bounded: reviewer/human
 * rejections create 'returned' attempts up to max_return, then escalate to a
 * human instead of looping.
 */

import { safeJsonParse } from '@greenhouse/utils/json';
import { nowIso } from '@greenhouse/utils/date';
import { logger } from '@greenhouse/utils/logger';
import { WORKFLOW_NODE_POLICY_DEFAULTS, type WorkflowGraph, type WorkflowNode } from '@greenhouse/types/workflow';
import { parseWorkflowGraph, resolveBudget } from './graph.js';
import { resolveInputs } from './blackboard.js';
import { settleRun } from './outcome.js';
import type { EngineDb, EngineEmitter, WorkflowRunRow } from './deps.js';
import type { ExecuteNodeArgs, ExecuteNodeResult, ReviewNodeArgs, ReviewNodeResult } from './node-executor.js';

export interface RunnerDeps {
  db: EngineDb;
  executeNode: (args: ExecuteNodeArgs) => Promise<ExecuteNodeResult>;
  reviewNode: (args: ReviewNodeArgs) => Promise<ReviewNodeResult>;
  emit?: EngineEmitter;
  abortSignal?: AbortSignal;
}

type NodeRunRowLike = {
  id: number;
  node_id: string;
  attempt: number;
  status: string;
  outputs: string | null;
  checks_result: string | null;
  error: string | null;
};

/** Statuses the scheduler keeps working on. 'paused' is a user stop — excluded on purpose. */
const ACTIVE_RUN_STATUSES = new Set(['running', 'paused_for_gate']);

/** Poll interval while waiting on a node run owned by a different drive loop. */
const FOREIGN_WAIT_MS = 250;
/**
 * Give up waiting on a foreign 'running' row past the longest node timeout —
 * beyond that the row is genuinely stuck rather than slow.
 */
const FOREIGN_WAIT_LIMIT_MS = 1_800_000 + 60_000;

/** Drive a run until it completes, fails, or blocks on human gates. */
export async function driveRun(deps: RunnerDeps, runId: string): Promise<void> {
  const { db } = deps;
  const first = await db.workflows.getRun(runId);
  if (!first || !ACTIVE_RUN_STATUSES.has(first.status)) return;

  const wf = await db.workflows.getById(first.workflow_id);
  if (!wf) return;
  // The run's own frozen graph wins: revising the definition mid-run (or after)
  // must not change what this run executes. Fall back for pre-snapshot rows.
  const graph = parseWorkflowGraph(first.graph ?? wf.graph);
  const parentSessionId = wf.created_from_session_id ?? null;
  const inFlight = new Map<string, Promise<void>>();
  let foreignWaitedMs = 0;

  const emit = (runStatus: string, nodeId?: string, nodeStatus?: string) =>
    deps.emit?.({ type: 'workflow:progress', runId, runStatus, nodeId, nodeStatus, userId: first.user_id });

  while (true) {
    const run = await db.workflows.getRun(runId);
    if (!run) break;

    const rows = (await db.workflows.listNodeRuns(runId)) as NodeRunRowLike[];
    const state = assessRows(graph, rows);

    // Sync progress BEFORE the exit checks — otherwise a run stopped mid-loop
    // (pause, cancel) is left displaying a stale node count.
    if (run.completed !== state.satisfied.size) {
      await db.workflows.updateRun(runId, { completed: state.satisfied.size });
    }

    if (!ACTIVE_RUN_STATUSES.has(run.status)) break;
    if (deps.abortSignal?.aborted) break;

    const budget = { ...resolveBudget(graph.budget), ...(safeJsonParse(run.budget, {}) as Record<string, number>) };

    // ── Terminal: everything satisfied ──
    if (state.satisfied.size === graph.nodes.length && inFlight.size === 0) {
      const summary = state.outputs.get(graph.deliverable_node) ?? null;
      const won = await settleRun(db, runId, { status: 'completed', summary: JSON.stringify(summary) });
      if (won) emit('completed');
      break;
    }

    const pendingGates = await db.workflows.listPendingGates(runId);
    if (run.status === 'paused_for_gate' && pendingGates.length === 0) {
      await db.workflows.updateRun(runId, { status: 'running' });
      emit('running');
    }

    // ── Budget guard ──
    if (run.tokens_used >= budget.max_tokens!) {
      if (inFlight.size > 0) {
        await Promise.race([...inFlight.values()]);
        continue;
      }
      const hasBudgetGate = pendingGates.some(
        (g) =>
          g.kind === 'escalation' && (safeJsonParse(g.payload, {}) as { reason?: string }).reason === 'budget_exceeded',
      );
      if (!hasBudgetGate) {
        await db.workflows.createGate({
          run_id: runId,
          kind: 'escalation',
          payload: JSON.stringify({
            reason: 'budget_exceeded',
            tokens_used: run.tokens_used,
            max_tokens: budget.max_tokens,
          }),
        });
      }
      await db.workflows.updateRun(runId, { status: 'paused_for_gate' });
      emit('paused_for_gate');
      break;
    }

    // ── Compute launchable actions (side effects: gates for guarded/exhausted nodes) ──
    const actions: Array<{ node: WorkflowNode; attempt: number; existingRowId?: number; feedback?: string }> = [];
    for (const node of graph.nodes) {
      if (state.satisfied.has(node.id) || inFlight.has(node.id)) continue;
      if (!(node.depends_on ?? []).every((d) => state.satisfied.has(d))) continue;
      const policy = { ...WORKFLOW_NODE_POLICY_DEFAULTS, ...(node.policy ?? {}) };
      const latest = state.latest.get(node.id);

      if (!latest) {
        if (node.gates?.before === 'human') {
          const allGates = await db.workflows.listGates(runId);
          if (!allGates.some((g) => g.kind === 'before_node' && g.node_id === node.id)) {
            await db.workflows.createNodeRun({ run_id: runId, node_id: node.id, attempt: 1, status: 'awaiting_gate' });
            await db.workflows.createGate({
              run_id: runId,
              node_id: node.id,
              kind: 'before_node',
              payload: JSON.stringify({ objective: node.brief.objective }),
            });
            emit(run.status, node.id, 'awaiting_gate');
          }
          continue;
        }
        actions.push({ node, attempt: 1 });
        continue;
      }

      if (latest.status === 'pending') {
        // Pre-created row released by a gate decision (before-gate approve, escalation retry).
        actions.push({ node, attempt: latest.attempt, existingRowId: latest.id, feedback: feedbackOf(latest) });
      } else if (latest.status === 'returned') {
        const returns = state.returnedCount.get(node.id) ?? 0;
        if (returns > policy.max_return) {
          await ensureEscalationGate(db, runId, node.id, pendingGates, {
            reason: 'max_return_exhausted',
            feedback: feedbackOf(latest),
          });
        } else {
          actions.push({ node, attempt: (state.attempts.get(node.id) ?? 0) + 1, feedback: feedbackOf(latest) });
        }
      } else if (latest.status === 'failed') {
        const failures = rows.filter((r) => r.node_id === node.id && r.status === 'failed').length;
        if (failures <= policy.max_retry) {
          actions.push({ node, attempt: (state.attempts.get(node.id) ?? 0) + 1 });
        } else {
          await ensureEscalationGate(db, runId, node.id, pendingGates, {
            reason: 'max_retry_exhausted',
            error: latest.error,
          });
        }
      }
      // 'awaiting_gate' / 'running' rows: not launchable here.
    }

    // ── Launch within concurrency ──
    const capacity = Math.max(0, (budget.concurrency ?? 1) - inFlight.size);
    for (const action of actions.slice(0, capacity)) {
      const { resolved, errors } = resolveInputs(action.node.brief.inputs, {
        taskInput: run.task_input,
        outputs: state.outputs,
      });
      if (errors.length > 0) {
        // Deterministic failure — record it without spending an LLM call.
        const row =
          action.existingRowId != null
            ? await db.workflows.getNodeRun(action.existingRowId)
            : await db.workflows.createNodeRun({ run_id: runId, node_id: action.node.id, attempt: action.attempt });
        await db.workflows.updateNodeRun(row!.id, {
          status: 'failed',
          error: `input resolution failed: ${errors.join('; ')}`,
          finished_at: nowIso(),
        });
        continue;
      }
      emit(run.status, action.node.id, 'running');
      const promise = (async () => {
        const res = await deps.executeNode({
          run: run as WorkflowRunRow,
          node: action.node,
          attempt: action.attempt,
          resolvedInputs: resolved,
          parentSessionId,
          feedback: action.feedback,
          existingRowId: action.existingRowId,
          allowMutations: action.node.id === graph.deliverable_node,
          abortSignal: deps.abortSignal,
        });
        await db.workflows.bumpRunProgress(runId, { tokens: res.tokens });
        if (res.status === 'passed') {
          await postProcessPassed(deps, runId, run as WorkflowRunRow, action.node, res, parentSessionId);
        }
        emit(run.status, action.node.id, res.status);
      })()
        .catch((err) => {
          logger.error('workflow node execution crashed', { runId, node: action.node.id, err: String(err) });
        })
        .finally(() => {
          inFlight.delete(action.node.id);
        });
      inFlight.set(action.node.id, promise);
    }

    if (inFlight.size === 0) {
      const nowPending = await db.workflows.listPendingGates(runId);
      if (nowPending.length > 0) {
        await db.workflows.updateRun(runId, { status: 'paused_for_gate' });
        emit('paused_for_gate');
        break;
      }
      if (state.satisfied.size === graph.nodes.length) continue; // finalize next iteration

      // A node may still be executing under a drive loop that exited earlier
      // (pause → resume starts a fresh loop). Wait for that row to land rather
      // than mistaking someone else's work for a stall.
      const foreignRunning = rows.some((r) => r.status === 'running');
      if (foreignRunning && foreignWaitedMs < FOREIGN_WAIT_LIMIT_MS) {
        foreignWaitedMs += FOREIGN_WAIT_MS;
        await new Promise((r) => setTimeout(r, FOREIGN_WAIT_MS));
        continue;
      }

      // Nothing running, nothing launchable, no gates: a definition bug — fail loudly.
      const won = await settleRun(db, runId, {
        status: 'failed',
        error: foreignRunning
          ? 'workflow stalled: a node run has been stuck in `running` past the maximum node timeout'
          : 'workflow stalled: no runnable nodes and no pending gates',
      });
      if (won) emit('failed');
      break;
    }

    await Promise.race([...inFlight.values()]);
  }
}

/** Reviewer checks + after-gate handling for a passed attempt. */
async function postProcessPassed(
  deps: RunnerDeps,
  runId: string,
  run: WorkflowRunRow,
  node: WorkflowNode,
  res: ExecuteNodeResult,
  parentSessionId: string | null,
): Promise<void> {
  const { db } = deps;
  const reviewer = (node.checks ?? []).find((c) => c.type === 'reviewer');
  if (reviewer && res.outputs) {
    const verdict = await deps.reviewNode({
      run,
      node,
      outputs: res.outputs,
      criteria: reviewer.type === 'reviewer' ? reviewer.criteria : undefined,
      agent: reviewer.type === 'reviewer' ? reviewer.agent : undefined,
      parentSessionId,
      abortSignal: deps.abortSignal,
    });
    if (verdict.tokens) await db.workflows.bumpRunProgress(runId, { tokens: verdict.tokens });
    if (!verdict.pass) {
      await db.workflows.updateNodeRun(res.rowId, {
        status: 'returned',
        checks_result: JSON.stringify({ reviewer: 'fail', feedback: verdict.feedback ?? '评审未通过' }),
      });
      return;
    }
    await db.workflows.updateNodeRun(res.rowId, {
      checks_result: JSON.stringify({ reviewer: 'pass' }),
    });
  }

  if (node.gates?.after === 'human') {
    await db.workflows.updateNodeRun(res.rowId, { status: 'awaiting_gate' });
    await db.workflows.createGate({
      run_id: runId,
      node_id: node.id,
      kind: 'after_node',
      payload: JSON.stringify({ outputs: res.outputs }),
    });
  }
}

// ─── Gate decisions ──────────────────────────────────────

export interface GateDecision {
  status: 'approved' | 'rejected';
  decided_by: string;
  note?: string;
}

/**
 * Apply a human decision to a pending gate. Mutates rows only — the caller is
 * responsible for driving the run again afterwards.
 */
export async function applyGateDecision(deps: RunnerDeps, gateId: number, decision: GateDecision): Promise<void> {
  const { db } = deps;
  const gate = await db.workflows.getGate(gateId);
  if (!gate) throw new Error(`gate ${gateId} not found`);
  if (gate.status !== 'pending') throw new Error(`gate ${gateId} is already ${gate.status}`);
  if (gate.kind === 'confirm_plan') throw new Error('confirm_plan gates are decided via the confirm endpoint');

  const decided = await db.workflows.decideGate(gateId, decision);
  if (!decided) throw new Error(`gate ${gateId} could not be decided`);

  const rows = (await db.workflows.listNodeRuns(gate.run_id)) as NodeRunRowLike[];
  const nodeRows = rows.filter((r) => r.node_id === gate.node_id);
  const latest = nodeRows.at(-1);
  const nextAttempt = (nodeRows.at(-1)?.attempt ?? 0) + 1;

  if (gate.kind === 'before_node') {
    if (!latest) throw new Error(`no node run row for before gate on ${gate.node_id}`);
    await db.workflows.updateNodeRun(latest.id, {
      status: decision.status === 'approved' ? 'pending' : 'skipped',
      checks_result: decision.note ? JSON.stringify({ gate_note: decision.note }) : undefined,
    });
    return;
  }

  if (gate.kind === 'after_node') {
    if (!latest) throw new Error(`no node run row for after gate on ${gate.node_id}`);
    if (decision.status === 'approved') {
      await db.workflows.updateNodeRun(latest.id, { status: 'passed' });
    } else {
      await db.workflows.updateNodeRun(latest.id, {
        status: 'returned',
        checks_result: JSON.stringify({ reviewer: 'human', feedback: decision.note ?? '人工驳回' }),
      });
    }
    return;
  }

  // escalation
  const payload = safeJsonParse(gate.payload, {}) as { reason?: string };
  if (decision.status === 'rejected') {
    await settleRun(db, gate.run_id, {
      status: 'failed',
      error: `aborted by user at escalation gate${decision.note ? `: ${decision.note}` : ''}`,
    });
    return;
  }
  if (payload.reason === 'budget_exceeded') {
    // Approval = raise the cap by one default increment and continue.
    const run = await db.workflows.getRun(gate.run_id);
    if (run) {
      const budget = safeJsonParse(run.budget, {}) as Record<string, number>;
      budget.max_tokens = (budget.max_tokens ?? 0) + 1_000_000;
      await db.workflows.updateRun(gate.run_id, { budget: JSON.stringify(budget) });
    }
    return;
  }
  const choice = decision.note?.trim();
  if (choice === 'retry') {
    await db.workflows.createNodeRun({
      run_id: gate.run_id,
      node_id: gate.node_id!,
      attempt: nextAttempt,
      status: 'pending',
    });
  } else if (choice === 'skip') {
    await db.workflows.createNodeRun({
      run_id: gate.run_id,
      node_id: gate.node_id!,
      attempt: nextAttempt,
      status: 'skipped',
    });
  } else {
    throw new Error("escalation approval requires note 'retry' or 'skip'");
  }
}

// ─── Manual intervention (outside the gate ladder) ───────

const TERMINAL_RUN_STATUSES = new Set(['completed', 'canceled']);

/**
 * User stop. The scheduler drops out of its loop on the next iteration, but
 * nodes already executing are deliberately NOT aborted — a node may be halfway
 * through a mutation, and node boundaries are where this engine checkpoints
 * (D10/D15). "Pause" therefore means "finish what is in flight, start nothing".
 */
export async function pauseRun(db: EngineDb, runId: string): Promise<void> {
  const run = await db.workflows.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (!ACTIVE_RUN_STATUSES.has(run.status)) throw new Error(`run is ${run.status}, not pausable`);
  // Settle the progress counter here too: the drive loop may be parked on an
  // in-flight node and would not sync it until that node lands.
  const completed = await countSatisfied(db, run);
  await db.workflows.updateRun(runId, { status: 'paused', completed });
}

/** Count nodes whose latest attempt is satisfied (passed or skipped). */
async function countSatisfied(db: EngineDb, run: WorkflowRunRow): Promise<number> {
  const graph = await runGraph(db, run);
  if (!graph) return 0;
  const rows = (await db.workflows.listNodeRuns(run.id)) as NodeRunRowLike[];
  return assessRows(graph, rows).satisfied.size;
}

/** The graph this run executes — its own frozen snapshot, else the definition. */
async function runGraph(db: EngineDb, run: WorkflowRunRow): Promise<WorkflowGraph | null> {
  if (run.graph) return parseWorkflowGraph(run.graph);
  const wf = await db.workflows.getById(run.workflow_id);
  return wf ? parseWorkflowGraph(wf.graph) : null;
}

/** Undo a pause. The caller drives the run again afterwards. */
export async function resumeRun(db: EngineDb, runId: string): Promise<void> {
  const run = await db.workflows.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== 'paused') throw new Error(`run is ${run.status}, not paused`);
  await db.workflows.updateRun(runId, { status: 'running' });
}

export interface RequeueNodeArgs {
  runId: string;
  nodeId: string;
  mode: 'retry' | 'skip';
  decidedBy: string;
}

/**
 * Manually queue one more attempt for a node (or write it off as skipped).
 *
 * Only nodes that did NOT succeed can be requeued: re-running a passed node
 * would leave downstream outputs derived from a superseded upstream result, and
 * cascading re-runs are a separate feature (D16). A run that already reached
 * `failed` is revived here — this is the "rescue one node and carry on" path.
 */
export async function requeueNode(db: EngineDb, args: RequeueNodeArgs): Promise<void> {
  const { runId, nodeId, mode } = args;
  const run = await db.workflows.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (TERMINAL_RUN_STATUSES.has(run.status)) throw new Error(`run is ${run.status}`);

  const graph = await runGraph(db, run);
  if (!graph) throw new Error('workflow not found');
  if (!graph.nodes.some((n) => n.id === nodeId)) throw new Error(`node ${nodeId} is not in this workflow`);

  const rows = (await db.workflows.listNodeRuns(runId)) as NodeRunRowLike[];
  const nodeRows = rows.filter((r) => r.node_id === nodeId);
  const latest = nodeRows.at(-1);
  if (latest && !['failed', 'skipped', 'returned'].includes(latest.status)) {
    throw new Error(`node ${nodeId} is ${latest.status} — only failed, skipped or returned nodes can be requeued`);
  }

  // Clear any escalation gate for this node; leaving it pending would keep the
  // run parked in paused_for_gate forever.
  for (const gate of await db.workflows.listPendingGates(runId)) {
    if (gate.kind === 'escalation' && gate.node_id === nodeId) {
      await db.workflows.decideGate(gate.id, {
        status: 'approved',
        decided_by: args.decidedBy,
        note: `manual ${mode}`,
      });
    }
  }

  await db.workflows.createNodeRun({
    run_id: runId,
    node_id: nodeId,
    attempt: (latest?.attempt ?? 0) + 1,
    status: mode === 'retry' ? 'pending' : 'skipped',
  });

  if (run.status === 'failed' || run.status === 'paused') {
    await db.workflows.updateRun(runId, { status: 'running', error: null, finished_at: null });
  }
}

// ─── Boot sweep ──────────────────────────────────────────

/**
 * Resume every unfinished run after a restart: attempts stranded in 'running'
 * are failed (node-boundary checkpointing — the node re-runs whole), then the
 * normal retry/escalation policy takes over.
 */
export async function resumeActiveRuns(deps: RunnerDeps): Promise<void> {
  const { db } = deps;
  const active = await db.workflows.listActiveRuns();
  for (const run of active) {
    const rows = (await db.workflows.listNodeRuns(run.id)) as NodeRunRowLike[];
    for (const row of rows) {
      if (row.status === 'running') {
        await db.workflows.updateNodeRun(row.id, {
          status: 'failed',
          error: 'interrupted by server restart',
          finished_at: nowIso(),
        });
      }
    }
    try {
      await driveRun(deps, run.id);
    } catch (err) {
      logger.error('workflow resume failed', { runId: run.id, err: String(err) });
    }
  }
}

// ─── Row assessment helpers ──────────────────────────────

function assessRows(graph: WorkflowGraph, rows: NodeRunRowLike[]) {
  const latest = new Map<string, NodeRunRowLike>();
  const attempts = new Map<string, number>();
  const returnedCount = new Map<string, number>();
  for (const row of rows) {
    latest.set(row.node_id, row);
    attempts.set(row.node_id, (attempts.get(row.node_id) ?? 0) + 1);
    if (row.status === 'returned') returnedCount.set(row.node_id, (returnedCount.get(row.node_id) ?? 0) + 1);
  }
  const satisfied = new Set<string>();
  const outputs = new Map<string, unknown>();
  for (const node of graph.nodes) {
    const row = latest.get(node.id);
    if (!row) continue;
    if (row.status === 'passed') {
      satisfied.add(node.id);
      outputs.set(node.id, row.outputs != null ? safeJsonParse(row.outputs, null) : null);
    } else if (row.status === 'skipped') {
      satisfied.add(node.id);
      outputs.set(node.id, null);
    }
  }
  return { latest, attempts, returnedCount, satisfied, outputs };
}

function feedbackOf(row: NodeRunRowLike): string | undefined {
  const checks = safeJsonParse(row.checks_result ?? '{}', {}) as { feedback?: string };
  return typeof checks.feedback === 'string' ? checks.feedback : undefined;
}

async function ensureEscalationGate(
  db: EngineDb,
  runId: string,
  nodeId: string,
  pendingGates: Array<{ kind: string; node_id: string | null; status: string }>,
  payload: Record<string, unknown>,
): Promise<void> {
  if (pendingGates.some((g) => g.kind === 'escalation' && g.node_id === nodeId)) return;
  await db.workflows.createGate({
    run_id: runId,
    node_id: nodeId,
    kind: 'escalation',
    payload: JSON.stringify({ ...payload, options: ['retry', 'skip', 'abort'] }),
  });
}
