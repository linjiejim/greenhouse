/**
 * In-memory fake of the db surface the workflow engine touches
 * (db.workflows + db.sessions), mirroring packages/db/src/services/workflows.ts.
 * Same style as spawn-session.test.ts — no Postgres needed.
 */

import { WORKFLOW_BUDGET_DEFAULTS, type WorkflowGraph } from '@greenhouse/types/workflow';

let now = 0;
const tick = () => new Date(1750000000000 + ++now * 1000).toISOString();

export const TEST_PROFILE = {
  id: 'team',
  name: 'Team',
  access: { level: 'internal' as const, rich_output: false },
  model: { id: 'flash', provider: 'openai-compatible', model: 'test-model' },
  tools: [] as string[],
  system_prompt: 'test system prompt',
  max_steps: 5,
};

export function makeFakeWorkflowDb() {
  const workflowRows = new Map<number, any>();
  const runs = new Map<string, any>();
  const nodeRuns: any[] = [];
  const gates: any[] = [];
  const sessions = new Map<string, any>();
  const messages: any[] = [];
  let wfSeq = 0;
  let nodeRunSeq = 0;
  let gateSeq = 0;
  let sessionSeq = 0;

  const workflows = {
    async create(input: any) {
      const row = {
        id: ++wfSeq,
        user_id: input.user_id,
        name: input.name,
        status: 'draft',
        version: 1,
        graph: input.graph,
        created_from_session_id: input.created_from_session_id ?? null,
        created_at: tick(),
        updated_at: tick(),
      };
      workflowRows.set(row.id, row);
      return row;
    },
    async getById(id: number) {
      return workflowRows.get(id);
    },
    async listByUser(userId: string) {
      return [...workflowRows.values()].filter((w) => w.user_id === userId);
    },
    async update(id: number, updates: any) {
      const row = workflowRows.get(id);
      if (!row) return undefined;
      if (updates.name !== undefined) row.name = updates.name;
      if (updates.graph !== undefined) row.graph = updates.graph;
      if (updates.status !== undefined) row.status = updates.status;
      if (updates.bumpVersion) row.version += 1;
      row.updated_at = tick();
      return row;
    },
    async createRun(input: any) {
      const row = {
        id: input.id,
        workflow_id: input.workflow_id,
        workflow_version: input.workflow_version,
        user_id: input.user_id,
        status: 'running',
        task_input: input.task_input,
        graph: input.graph ?? null,
        budget: input.budget,
        total: input.total,
        completed: 0,
        tokens_used: 0,
        summary: null,
        error: null,
        started_at: tick(),
        finished_at: null,
        created_at: tick(),
      };
      runs.set(row.id, row);
      return row;
    },
    async getRun(id: string) {
      return runs.get(id);
    },
    async listRunsByWorkflow(workflowId: number) {
      return [...runs.values()].filter((r) => r.workflow_id === workflowId);
    },
    async listActiveRuns() {
      return [...runs.values()].filter((r) => r.status === 'running' || r.status === 'paused_for_gate');
    },
    async updateRun(id: string, updates: any) {
      const row = runs.get(id);
      if (!row) return undefined;
      for (const k of ['status', 'summary', 'error', 'finished_at', 'completed', 'budget'] as const) {
        if (updates[k] !== undefined) row[k] = updates[k];
      }
      return row;
    },
    /** Mirrors the real CAS: only transitions a row still in `from`. */
    async transitionRun(id: string, from: readonly string[], updates: any) {
      const row = runs.get(id);
      if (!row || !from.includes(row.status)) return undefined;
      for (const k of ['status', 'summary', 'error', 'finished_at'] as const) {
        if (updates[k] !== undefined) row[k] = updates[k];
      }
      return row;
    },
    async bumpRunProgress(id: string, delta: any) {
      const row = runs.get(id);
      if (!row) return undefined;
      row.completed += delta.completed ?? 0;
      row.tokens_used += delta.tokens ?? 0;
      return row;
    },
    async createNodeRun(input: any) {
      const row = {
        id: ++nodeRunSeq,
        run_id: input.run_id,
        node_id: input.node_id,
        attempt: input.attempt ?? 1,
        status: input.status ?? 'pending',
        session_id: null,
        inputs: input.inputs ?? '{}',
        outputs: null,
        checks_result: null,
        error: null,
        tokens: null,
        duration_ms: null,
        started_at: null,
        finished_at: null,
        created_at: tick(),
      };
      nodeRuns.push(row);
      return row;
    },
    async getNodeRun(id: number) {
      return nodeRuns.find((r) => r.id === id);
    },
    async listNodeRuns(runId: string) {
      return nodeRuns.filter((r) => r.run_id === runId);
    },
    async updateNodeRun(id: number, updates: any) {
      const row = nodeRuns.find((r) => r.id === id);
      if (!row) return undefined;
      for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) row[k] = v;
      }
      return row;
    },
    async createGate(input: any) {
      const row = {
        id: ++gateSeq,
        run_id: input.run_id,
        node_id: input.node_id ?? null,
        kind: input.kind,
        payload: input.payload ?? '{}',
        status: 'pending',
        decided_by: null,
        note: null,
        decided_at: null,
        created_at: tick(),
      };
      gates.push(row);
      return row;
    },
    async getGate(id: number) {
      return gates.find((g) => g.id === id);
    },
    async listGates(runId: string) {
      return gates.filter((g) => g.run_id === runId);
    },
    async listPendingGates(runId: string) {
      return gates.filter((g) => g.run_id === runId && g.status === 'pending');
    },
    async decideGate(id: number, decision: any) {
      const row = gates.find((g) => g.id === id && g.status === 'pending');
      if (!row) return undefined;
      row.status = decision.status;
      row.decided_by = decision.decided_by;
      row.note = decision.note ?? null;
      row.decided_at = tick();
      return row;
    },
  };

  const sessionsSvc = {
    async create(
      title?: string,
      profileId?: string,
      userId?: string,
      appId?: string,
      channel?: string,
      parentSessionId?: string,
    ) {
      const id = `ws_${++sessionSeq}`;
      const row = {
        id,
        title: title ?? null,
        status: 'active',
        profile_id: profileId ?? 'team',
        user_id: userId ?? null,
        app_id: appId ?? null,
        channel: channel ?? 'web',
        parent_session_id: parentSessionId ?? null,
        metadata: '{}',
        created_at: tick(),
        updated_at: tick(),
      };
      sessions.set(id, row);
      return row;
    },
    async getById(id: string) {
      return sessions.get(id);
    },
    async addMessage(input: any) {
      const row = { id: `m_${messages.length + 1}`, ...input };
      messages.push(row);
      return row;
    },
    async getLatestMessage(sessionId: string) {
      return messages.filter((message: any) => message.session_id === sessionId).at(-1);
    },
    async appendAssistantIfTail(sessionId: string, expectedTail: { id: string; content: string }, input: any) {
      const latest = messages.filter((message: any) => message.session_id === sessionId).at(-1);
      if (!latest || latest.id !== expectedTail.id || latest.content !== expectedTail.content) {
        return { ok: false, reason: 'transcript_changed' as const };
      }
      const row = { id: `m_${messages.length + 1}`, ...input };
      messages.push(row);
      return { ok: true, message: row };
    },
    async touch() {},
  };

  const budgetReservations = new Map<string, { status: string; estimated: number }>();
  const usageBudget = {
    async reserveMonthlyUser(input: { idempotency_key: string; estimated_units: number }) {
      budgetReservations.set(input.idempotency_key, { status: 'reserved', estimated: input.estimated_units });
      return { idempotency_key: input.idempotency_key };
    },
    async settle(input: { idempotency_key: string }) {
      const row = budgetReservations.get(input.idempotency_key);
      if (row) row.status = 'settled';
      return row;
    },
    async release(input: { idempotency_key: string }) {
      const row = budgetReservations.get(input.idempotency_key);
      if (row) row.status = 'released';
      return true;
    },
  };
  const users = {
    async getById(id: string) {
      return { id, status: 'active', role: 'team', monthly_token_limit: 20_000_000 };
    },
  };
  const usage = { async record() {} };

  return {
    _workflows: workflowRows,
    _runs: runs,
    _nodeRuns: nodeRuns,
    _gates: gates,
    _sessions: sessions,
    _messages: messages,
    workflows,
    sessions: sessionsSvc,
    users,
    usage,
    usageBudget,
  };
}

export type FakeWorkflowDb = ReturnType<typeof makeFakeWorkflowDb>;

/** Seed a workflow + run pair; returns the run row. */
export async function makeRun(
  db: FakeWorkflowDb,
  graph?: WorkflowGraph,
  opts: { budget?: Record<string, unknown>; taskInput?: string } = {},
) {
  const g: WorkflowGraph = graph ?? {
    nodes: [{ id: 'solo', agent: 'team', brief: { objective: 'do it' } }],
    deliverable_node: 'solo',
  };
  const wf = await db.workflows.create({ user_id: 'u1', name: 'test wf', graph: JSON.stringify(g) });
  await db.workflows.update(wf.id, { status: 'confirmed' });
  return await db.workflows.createRun({
    id: `run_${wf.id}`,
    workflow_id: wf.id,
    workflow_version: wf.version,
    user_id: 'u1',
    task_input: opts.taskInput ?? '完成测试任务',
    // Production snapshots the confirmed graph onto the run; mirror that here.
    graph: JSON.stringify(g),
    budget: JSON.stringify({ ...WORKFLOW_BUDGET_DEFAULTS, ...(opts.budget ?? {}) }),
    total: g.nodes.length,
  });
}

/**
 * Build an executeNode stub honoring the engine contract (creates/updates its
 * own node-run row). `plan[nodeId]` is consumed one result per attempt;
 * results: {outputs}, {error}, or {tokens}. Records call order + peak overlap.
 */
export function stubExecutor(
  db: FakeWorkflowDb,
  plan: Record<string, Array<{ outputs?: unknown; error?: string; tokens?: number; delayMs?: number }>>,
) {
  const calls: Array<{ node: string; attempt: number; resolvedInputs: Record<string, unknown>; feedback?: string }> =
    [];
  let inFlight = 0;
  let peakInFlight = 0;

  const exec = async (args: any) => {
    const { run, node, attempt, resolvedInputs, feedback, existingRowId } = args;
    calls.push({ node: node.id, attempt, resolvedInputs, feedback });
    const spec = plan[node.id]?.shift() ?? { outputs: { done: node.id } };

    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);

    const row =
      existingRowId != null
        ? await db.workflows.getNodeRun(existingRowId)
        : await db.workflows.createNodeRun({
            run_id: run.id,
            node_id: node.id,
            attempt,
            inputs: JSON.stringify(resolvedInputs),
          });
    await db.workflows.updateNodeRun(row!.id, { status: 'running', started_at: new Date().toISOString() });

    if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
    inFlight -= 1;

    const tokens = spec.tokens ?? 10;
    if (spec.error) {
      await db.workflows.updateNodeRun(row!.id, { status: 'failed', error: spec.error, tokens });
      return { rowId: row!.id, status: 'failed' as const, outputs: null, error: spec.error, tokens };
    }
    await db.workflows.updateNodeRun(row!.id, {
      status: 'passed',
      outputs: JSON.stringify(spec.outputs ?? {}),
      tokens,
    });
    return { rowId: row!.id, status: 'passed' as const, outputs: spec.outputs ?? {}, error: null, tokens };
  };

  return { exec, calls, peak: () => peakInFlight };
}
