/**
 * Workflow engine singleton — production wiring for the run driver.
 *
 * Node identity comes from the SAME profile + permission chain as chat
 * (resolveProfileAsync → resolveEffectiveTools → buildLazyServerTools), so a
 * node's tool set can never exceed the run owner's permissions. Mutation tools
 * reach ONLY the deliverable node (writes single-threaded); every other node is
 * stripped to read-safe tools. Progress is pushed to the owner over WS.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { WORKFLOW_BUDGET_LIMITS, type WorkflowBudget } from '@greenhouse/types/workflow';
import { resolveProfileAsync, enrichSystemPrompt, type AgentProfile } from '../profile.js';
import { resolveMemoryContext } from '../llm/memory.js';
import {
  resolveEffectiveTools,
  buildLazyServerTools,
  DISPATCH_TOOL_IDS,
  filterUnattendedToolIds,
  LAZY_TOOL_IDS,
  UNATTENDED_TOOL_DENYLIST,
} from '../agent-runtime/tool-resolution.js';
import { selectTools, type ToolRegistry } from '../agent.js';
import { connectionManager } from '../ws/connection-manager.js';
import {
  driveRun,
  applyGateDecision,
  resumeActiveRuns,
  pauseRun,
  resumeRun,
  requeueNode,
  type GateDecision,
  type RunnerDeps,
} from './runner.js';
import { executeNode, reviewNode, type ExecuteNodeDeps } from './node-executor.js';
import { settleRun } from './outcome.js';
import { parseWorkflowGraph, resolveBudget } from './graph.js';
import type { EngineProfile } from './deps.js';
import { mirrorRuntimeRunSoon } from '../runtime/adapters.js';

/**
 * Tools that never make sense inside a headless workflow node: interactive
 * chat UX (ask_user's passthrough would dangle forever), recursion vectors,
 * dispatch tools whose confirm card has no human to press it, and
 * write-capable conversational managers that bypass the proxy confirm gate.
 *
 * Composed from two shared sets plus the node-specific entries: the dispatch
 * drafts (their confirm card needs a human) and the unattended denylist that
 * scheduled runs apply too. Exported so the denylist regression test can pin
 * both unattended contexts at once.
 */
export const NODE_TOOL_DENYLIST = new Set([
  ...DISPATCH_TOOL_IDS,
  ...UNATTENDED_TOOL_DENYLIST,
  'spawn_session',
  'ask_user',
  'eval_message',
  'feature_request',
]);

class WorkflowEngine {
  private driving = new Map<string, Promise<void>>();
  private aborts = new Map<string, AbortController>();
  /** Runs asked to drive while a loop was still winding down (pause→resume, gate decisions). */
  private rearm = new Set<string>();

  constructor(private toolRegistry: ToolRegistry) {}

  // ─── Runner dependency wiring ──────────────────────────

  private execDeps(): ExecuteNodeDeps {
    const db = getDb();
    return {
      db,
      resolveProfile: async (profileId: string): Promise<EngineProfile> => await resolveProfileAsync(profileId),
      enrichSystem: (profile) => enrichSystemPrompt(profile as AgentProfile),
      resolveUserContext: (userId) => resolveMemoryContext(userId),
      assembleTools: async ({ sessionId, profile, userId, runtimeRunId }) => {
        const user = await db.users.getById(userId);
        if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) {
          throw new Error('workflow owner is no longer an active internal user');
        }
        const full = await resolveProfileAsync(profile.id);
        const { effectiveTools } = await resolveEffectiveTools({
          userId,
          userRole: user.role,
          profile: full,
          profileId: full.id,
        });
        // A confirmed graph is not approval for each future write payload.
        // Until exact-input Runtime Interrupts wrap R1 actions, every headless
        // node — including the deliverable node — is strictly read-only.
        const ids = filterUnattendedToolIds(effectiveTools).filter((t) => !NODE_TOOL_DENYLIST.has(t));
        const tools = selectTools(
          this.toolRegistry,
          ids.filter((t) => !LAZY_TOOL_IDS.has(t)),
        );
        Object.assign(
          tools,
          buildLazyServerTools(db, ids, {
            userId,
            userRole: user.role,
            sessionId,
            profileId: full.id,
            toolRegistry: this.toolRegistry,
            unattended: true,
            runtimeRunId: runtimeRunId ?? null,
          }),
        );
        return tools;
      },
    };
  }

  private runnerDeps(abortSignal?: AbortSignal): RunnerDeps {
    const exec = this.execDeps();
    return {
      db: exec.db,
      executeNode: async (args) => {
        const runtimeRun = await getDb().runtime.getRunBySource('workflow', 'workflow_run', args.run.id);
        return executeNode(exec, { ...args, runtimeRunId: runtimeRun?.id ?? null });
      },
      reviewNode: (args) => reviewNode(exec, args),
      abortSignal,
      emit: (event) => {
        connectionManager.sendToUser(event.userId, {
          type: 'workflow:progress',
          runId: event.runId,
          runStatus: event.runStatus,
          nodeId: event.nodeId,
          nodeStatus: event.nodeStatus,
        });
      },
    };
  }

  /**
   * Push a run transition that happened outside the drive loop (pause, resume,
   * requeue, cancel) so every open dock reflects it immediately instead of
   * waiting for its fallback poll.
   */
  private async emitRunState(runId: string, nodeId?: string): Promise<void> {
    const run = await getDb().workflows.getRun(runId);
    if (!run) return;
    connectionManager.sendToUser(run.user_id, {
      type: 'workflow:progress',
      runId,
      runStatus: run.status,
      nodeId,
    });
  }

  // ─── Public API ────────────────────────────────────────

  /** Confirm-time entry: create the run row + gate record, then drive it. */
  async startRun(args: {
    workflowId: number;
    userId: string;
    taskInput: string;
    budgetOverride?: Partial<WorkflowBudget>;
  }): Promise<{ runId: string }> {
    const db = getDb();
    const wf = await db.workflows.getById(args.workflowId);
    if (!wf) throw new Error('workflow not found');
    const graph = parseWorkflowGraph(wf.graph);

    const budget = { ...resolveBudget(graph.budget), ...(args.budgetOverride ?? {}) };
    for (const key of ['max_nodes', 'concurrency', 'max_tokens'] as const) {
      if (budget[key] > WORKFLOW_BUDGET_LIMITS[key]) {
        throw new Error(`budget ${key} exceeds hard limit ${WORKFLOW_BUDGET_LIMITS[key]}`);
      }
      if (budget[key] < 1) throw new Error(`budget ${key} must be positive`);
    }

    if (wf.status !== 'confirmed') {
      await db.workflows.update(wf.id, { status: 'confirmed' });
    }
    const runId = randomUUID();
    await db.workflows.createRun({
      id: runId,
      workflow_id: wf.id,
      workflow_version: wf.version,
      user_id: args.userId,
      task_input: args.taskInput,
      // Freeze the confirmed definition: later revisions must not rewrite what
      // this run executed, nor what the user actually approved.
      graph: wf.graph,
      budget: JSON.stringify(budget),
      total: graph.nodes.length,
    });
    // Record the human confirmation as a decided gate (audit trail).
    const gate = await db.workflows.createGate({
      run_id: runId,
      kind: 'confirm_plan',
      payload: JSON.stringify({ workflow_version: wf.version, budget }),
    });
    await db.workflows.decideGate(gate.id, { status: 'approved', decided_by: args.userId });

    mirrorRuntimeRunSoon('workflow', runId);
    this.ensureDriving(runId);
    return { runId };
  }

  /**
   * Idempotent: at most one drive loop per run per process. If a loop is still
   * winding down (a paused loop finishing its in-flight node, a loop that just
   * parked on a gate), the request is re-armed and fires when that loop exits —
   * otherwise resume/gate decisions taken during the wind-down window would be
   * silently dropped.
   */
  ensureDriving(runId: string): void {
    if (this.driving.has(runId)) {
      this.rearm.add(runId);
      return;
    }
    const controller = new AbortController();
    this.aborts.set(runId, controller);
    const promise = driveRun(this.runnerDeps(controller.signal), runId)
      .catch((err) => {
        logger.error('workflow drive loop crashed', { runId, err: String(err) });
      })
      .finally(() => {
        this.driving.delete(runId);
        this.aborts.delete(runId);
        if (this.rearm.delete(runId)) this.ensureDriving(runId);
      });
    this.driving.set(runId, promise);
  }

  /** User stop — in-flight nodes finish, nothing new starts. */
  async pauseRun(runId: string): Promise<void> {
    await pauseRun(getDb(), runId);
    await this.emitRunState(runId);
  }

  async resumeRun(runId: string): Promise<void> {
    await resumeRun(getDb(), runId);
    await this.emitRunState(runId);
    this.ensureDriving(runId);
  }

  /** Manually queue another attempt for a node, or write it off as skipped. */
  async requeueNode(args: { runId: string; nodeId: string; mode: 'retry' | 'skip'; userId: string }): Promise<void> {
    await requeueNode(getDb(), {
      runId: args.runId,
      nodeId: args.nodeId,
      mode: args.mode,
      decidedBy: args.userId,
    });
    await this.emitRunState(args.runId, args.nodeId);
    this.ensureDriving(args.runId);
  }

  async cancelRun(runId: string): Promise<void> {
    const db = getDb();
    this.aborts.get(runId)?.abort();
    // CAS: if the drive loop finalized this run first it keeps its outcome —
    // a cancel arriving a moment too late must not overwrite a completed run
    // nor append a second outcome message.
    await settleRun(db, runId, { status: 'canceled' });
    await this.emitRunState(runId);
  }

  async cancelRunsForUser(userId: string): Promise<number> {
    const runs = await getDb().workflows.listActiveRunsByUser(userId);
    for (const run of runs) await this.cancelRun(run.id);
    return runs.length;
  }

  /** Decide a pending gate, then resume the run. */
  async decideGate(gateId: number, decision: GateDecision): Promise<void> {
    const deps = this.runnerDeps();
    await applyGateDecision(deps, gateId, decision);
    const gate = await getDb().workflows.getGate(gateId);
    if (gate) this.ensureDriving(gate.run_id);
  }

  /** Boot sweep: resume unfinished runs after a restart. */
  async resumeAll(): Promise<void> {
    const db = getDb();
    const active = await db.workflows.listActiveRuns();
    if (active.length === 0) return;
    logger.info(`[workflow-engine] resuming ${active.length} unfinished run(s) after restart`);
    await resumeActiveRuns(this.runnerDeps());
  }
}

let _engine: WorkflowEngine | null = null;

export function initWorkflowEngine(toolRegistry: ToolRegistry): WorkflowEngine {
  _engine = new WorkflowEngine(toolRegistry);
  // Fire-and-forget: recovery must not block server startup.
  void _engine.resumeAll().catch((err) => {
    logger.error('workflow boot sweep failed', { err: String(err) });
  });
  return _engine;
}

export function getWorkflowEngine(): WorkflowEngine {
  if (!_engine) throw new Error('Workflow engine not initialized. Call initWorkflowEngine() first.');
  return _engine;
}
