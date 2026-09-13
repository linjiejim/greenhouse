/**
 * Workflow 图编排 routes — /api/workflows
 *
 * GET    /                              我的工作流列表（含最近 run 状态）
 * GET    /runs/latest?session_id=       某会话最近一次 run（Run Dock 数据源）
 * GET    /runs/:runId                   run 详情（节点状态树 + gates + 图定义）
 * POST   /runs/:runId/cancel            取消 run
 * POST   /runs/:runId/pause|resume      用户暂停 / 恢复
 * POST   /runs/:runId/nodes/:nodeId/retry|skip  节点级人工干预
 * POST   /runs/:runId/gates/:gateId/decide  人工门决议（approve/reject + note）
 * GET    /:id                           工作流定义 + runs 列表
 * PATCH  /:id                           修订图定义（version+1）
 * POST   /:id/confirm                   确认计划并启动 run（唯一的执行入口）
 *
 * Permission: super（挂载处同时保护 collection root 与所有子路径）；
 * owner 检查继续作为对象级纵深防御保留。
 */

import { Hono, type Context } from 'hono';
import { getDb } from '@greenhouse/db';
import type { WorkflowGateRow, WorkflowNodeRunRow, WorkflowRow, WorkflowRunRow } from '@greenhouse/db';
import { safeJsonParse } from '@greenhouse/utils/json';
import { toErrorMessage } from '@greenhouse/utils/error';
import type {
  WorkflowBudget,
  WorkflowGateView,
  WorkflowGraph,
  WorkflowNodeRunView,
  WorkflowRunView,
} from '@greenhouse/types/workflow';
import { getAuthUser } from '../auth/middleware.js';
import { getWorkflowEngine } from '../workflow-engine/index.js';
import { validateWorkflowGraph, resolveBudget } from '../workflow-engine/graph.js';
import { sanitizeForPrompt } from '../security.js';
import type { AppEnv } from '../app-env.js';

// ─── View assembly ───────────────────────────────────────

function gateView(g: WorkflowGateRow): WorkflowGateView {
  return {
    id: g.id,
    node_id: g.node_id,
    kind: g.kind,
    status: g.status,
    payload: safeJsonParse(g.payload, {}) as Record<string, unknown>,
    note: g.note,
    created_at: g.created_at,
    decided_at: g.decided_at,
  };
}

function nodeRunView(r: WorkflowNodeRunRow): WorkflowNodeRunView {
  return {
    id: r.id,
    node_id: r.node_id,
    attempt: r.attempt,
    status: r.status,
    session_id: r.session_id,
    inputs: r.inputs ? (safeJsonParse(r.inputs, {}) as Record<string, unknown>) : null,
    outputs: r.outputs ? (safeJsonParse(r.outputs, {}) as Record<string, unknown>) : null,
    checks_result: r.checks_result ? (safeJsonParse(r.checks_result, {}) as Record<string, unknown>) : null,
    error: r.error,
    tokens: r.tokens,
    duration_ms: r.duration_ms,
    started_at: r.started_at,
    finished_at: r.finished_at,
  };
}

function runView(
  run: WorkflowRunRow,
  wf: WorkflowRow,
  nodeRuns: WorkflowNodeRunRow[],
  gates: WorkflowGateRow[],
): WorkflowRunView {
  return {
    id: run.id,
    workflow_id: run.workflow_id,
    name: wf.name,
    workflow_version: run.workflow_version,
    status: run.status,
    task_input: run.task_input,
    budget: { ...resolveBudget(), ...(safeJsonParse(run.budget, {}) as Partial<WorkflowBudget>) } as WorkflowBudget,
    tokens_used: run.tokens_used,
    total: run.total,
    completed: run.completed,
    // The run's frozen graph, so revising the definition never rewrites what a
    // finished run shows. `wf.graph` is only the pre-snapshot fallback.
    graph: safeJsonParse(run.graph ?? wf.graph, { nodes: [], deliverable_node: '' }) as WorkflowGraph,
    node_runs: nodeRuns.map(nodeRunView),
    gates: gates.map(gateView),
    summary: run.summary ? (safeJsonParse(run.summary, {}) as Record<string, unknown>) : null,
    error: run.error,
    started_at: run.started_at,
    finished_at: run.finished_at,
  };
}

function canAccess(user: { id: string; role: string }, ownerId: string): boolean {
  return user.role === 'super' || user.id === ownerId;
}

/** Shared handler for the retry/skip node routes (identical but for the mode). */
async function requeue(c: Context<AppEnv>, mode: 'retry' | 'skip') {
  const user = getAuthUser(c);
  const runId = c.req.param('runId') ?? '';
  const nodeId = c.req.param('nodeId') ?? '';
  const run = await getDb().workflows.getRun(runId);
  if (!run || !canAccess(user, run.user_id)) return c.json({ error: 'run not found' }, 404);
  try {
    await getWorkflowEngine().requeueNode({ runId: run.id, nodeId, mode, userId: user.id });
  } catch (err) {
    return c.json({ error: toErrorMessage(err) }, 400);
  }
  return c.json({ ok: true });
}

// ─── Routes ──────────────────────────────────────────────

export function createWorkflowsRoute() {
  const app = new Hono<AppEnv>()
    // 我的工作流列表（super 也只看自己的 — 列表是工作区视角）
    .get('/', async (c) => {
      const user = getAuthUser(c);
      const db = getDb();
      const workflows = await db.workflows.listByUser(user.id);
      const items = await Promise.all(
        workflows.map(async (wf) => {
          const runs = await db.workflows.listRunsByWorkflow(wf.id);
          const latest = runs[0];
          return {
            id: wf.id,
            name: wf.name,
            status: wf.status,
            version: wf.version,
            node_count: (safeJsonParse(wf.graph, { nodes: [], deliverable_node: '' }) as WorkflowGraph).nodes.length,
            updated_at: wf.updated_at,
            latest_run: latest ? { id: latest.id, status: latest.status, created_at: latest.created_at } : null,
          };
        }),
      );
      return c.json({ workflows: items });
    })

    // 某个聊天会话最近一次 run —— Run Dock 的数据源（无 run 时返回 null）
    .get('/runs/latest', async (c) => {
      const user = getAuthUser(c);
      const sessionId = c.req.query('session_id');
      if (!sessionId) return c.json({ error: 'session_id is required' }, 400);
      const db = getDb();
      const run = await db.workflows.findLatestRunBySession(user.id, sessionId);
      if (!run) return c.json({ run: null });
      const wf = await db.workflows.getById(run.workflow_id);
      if (!wf) return c.json({ run: null });
      const [nodeRuns, gates] = await Promise.all([db.workflows.listNodeRuns(run.id), db.workflows.listGates(run.id)]);
      return c.json({ run: runView(run, wf, nodeRuns, gates) });
    })

    // run 详情（run 卡片轮询 + WS 增量的数据源）
    .get('/runs/:runId', async (c) => {
      const user = getAuthUser(c);
      const db = getDb();
      const run = await db.workflows.getRun(c.req.param('runId'));
      if (!run || !canAccess(user, run.user_id)) return c.json({ error: 'run not found' }, 404);
      const wf = await db.workflows.getById(run.workflow_id);
      if (!wf) return c.json({ error: 'workflow not found' }, 404);
      const [nodeRuns, gates] = await Promise.all([db.workflows.listNodeRuns(run.id), db.workflows.listGates(run.id)]);
      return c.json({ run: runView(run, wf, nodeRuns, gates) });
    })

    .post('/runs/:runId/cancel', async (c) => {
      const user = getAuthUser(c);
      const db = getDb();
      const run = await db.workflows.getRun(c.req.param('runId'));
      if (!run || !canAccess(user, run.user_id)) return c.json({ error: 'run not found' }, 404);
      if (run.status === 'completed' || run.status === 'failed' || run.status === 'canceled') {
        return c.json({ error: `run is already ${run.status}` }, 400);
      }
      await getWorkflowEngine().cancelRun(run.id);
      return c.json({ ok: true });
    })

    // 用户主动暂停 / 恢复（在飞节点跑完即停，不中断 mutation）
    .post('/runs/:runId/pause', async (c) => {
      const user = getAuthUser(c);
      const run = await getDb().workflows.getRun(c.req.param('runId'));
      if (!run || !canAccess(user, run.user_id)) return c.json({ error: 'run not found' }, 404);
      try {
        await getWorkflowEngine().pauseRun(run.id);
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 400);
      }
      return c.json({ ok: true });
    })

    .post('/runs/:runId/resume', async (c) => {
      const user = getAuthUser(c);
      const run = await getDb().workflows.getRun(c.req.param('runId'));
      if (!run || !canAccess(user, run.user_id)) return c.json({ error: 'run not found' }, 404);
      try {
        await getWorkflowEngine().resumeRun(run.id);
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 400);
      }
      return c.json({ ok: true });
    })

    // 节点级人工干预：重试 / 跳过（仅对未通过的节点，见 D16）
    .post('/runs/:runId/nodes/:nodeId/retry', async (c) => requeue(c, 'retry'))
    .post('/runs/:runId/nodes/:nodeId/skip', async (c) => requeue(c, 'skip'))

    .post('/runs/:runId/gates/:gateId/decide', async (c) => {
      const user = getAuthUser(c);
      const db = getDb();
      const run = await db.workflows.getRun(c.req.param('runId'));
      if (!run || !canAccess(user, run.user_id)) return c.json({ error: 'run not found' }, 404);
      const gateId = Number.parseInt(c.req.param('gateId'), 10);
      const gate = await db.workflows.getGate(gateId);
      if (!gate || gate.run_id !== run.id) return c.json({ error: 'gate not found' }, 404);

      const body = await c.req
        .json<{ status?: string; note?: string }>()
        .catch(() => ({}) as { status?: string; note?: string });
      if (body.status !== 'approved' && body.status !== 'rejected') {
        return c.json({ error: "status must be 'approved' or 'rejected'" }, 400);
      }
      const note = typeof body.note === 'string' ? sanitizeForPrompt(body.note).slice(0, 2000) : undefined;
      try {
        await getWorkflowEngine().decideGate(gateId, { status: body.status, decided_by: user.id, note });
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 400);
      }
      return c.json({ ok: true });
    })

    // 定义 + runs（plan 卡片确认前用）
    .get('/:id', async (c) => {
      const user = getAuthUser(c);
      const db = getDb();
      const wf = await db.workflows.getById(Number.parseInt(c.req.param('id'), 10));
      if (!wf || !canAccess(user, wf.user_id)) return c.json({ error: 'workflow not found' }, 404);
      const runs = await db.workflows.listRunsByWorkflow(wf.id);
      return c.json({
        workflow: {
          id: wf.id,
          name: wf.name,
          status: wf.status,
          version: wf.version,
          graph: safeJsonParse(wf.graph, { nodes: [], deliverable_node: '' }) as WorkflowGraph,
          created_from_session_id: wf.created_from_session_id,
          updated_at: wf.updated_at,
        },
        runs: runs.map((r) => ({ id: r.id, status: r.status, created_at: r.created_at, finished_at: r.finished_at })),
      });
    })

    // 人工修订图（plan 卡片上的编辑保存）；结构性修订 version+1
    .patch('/:id', async (c) => {
      const user = getAuthUser(c);
      const db = getDb();
      const wf = await db.workflows.getById(Number.parseInt(c.req.param('id'), 10));
      if (!wf || !canAccess(user, wf.user_id)) return c.json({ error: 'workflow not found' }, 404);
      if (wf.status === 'archived') return c.json({ error: 'workflow is archived' }, 400);

      // The engine reads the live definition each scheduling pass, so editing
      // mid-run would silently change the run in flight. Freeze it instead.
      const activeRuns = await db.workflows.listRunsByWorkflow(wf.id);
      if (activeRuns.some((r) => r.status === 'running' || r.status === 'paused' || r.status === 'paused_for_gate')) {
        return c.json({ error: 'workflow has an active run — cancel it before editing the graph' }, 409);
      }

      const body = await c.req
        .json<{ name?: string; graph?: WorkflowGraph }>()
        .catch(() => ({}) as { name?: string; graph?: WorkflowGraph });
      if (body.graph) {
        const errors = validateWorkflowGraph(body.graph);
        if (errors.length > 0) return c.json({ error: `invalid graph: ${errors.join('; ')}` }, 400);
      }
      const name = typeof body.name === 'string' ? body.name.slice(0, 120) : undefined;
      const updated = await db.workflows.update(wf.id, {
        name,
        graph: body.graph ? JSON.stringify(body.graph) : undefined,
        bumpVersion: Boolean(body.graph),
      });
      return c.json({ workflow: { id: updated!.id, version: updated!.version, status: updated!.status } });
    })

    // 确认计划并启动 run — 执行的唯一入口（人工确认门）
    .post('/:id/confirm', async (c) => {
      const user = getAuthUser(c);
      const db = getDb();
      const wf = await db.workflows.getById(Number.parseInt(c.req.param('id'), 10));
      if (!wf || !canAccess(user, wf.user_id)) return c.json({ error: 'workflow not found' }, 404);
      if (wf.status === 'archived') return c.json({ error: 'workflow is archived' }, 400);

      const runs = await db.workflows.listRunsByWorkflow(wf.id);
      if (runs.some((r) => r.status === 'running' || r.status === 'paused_for_gate')) {
        return c.json({ error: 'workflow already has an active run' }, 409);
      }

      const body = await c.req
        .json<{ task_input?: string; budget?: Partial<WorkflowBudget> }>()
        .catch(() => ({}) as { task_input?: string; budget?: Partial<WorkflowBudget> });
      const taskInput = typeof body.task_input === 'string' ? sanitizeForPrompt(body.task_input).trim() : '';
      if (taskInput.length === 0 || taskInput.length > 8000) {
        return c.json({ error: 'task_input is required (1–8000 chars)' }, 400);
      }

      try {
        const { runId } = await getWorkflowEngine().startRun({
          workflowId: wf.id,
          userId: user.id,
          taskInput,
          budgetOverride: body.budget,
        });
        return c.json({ run_id: runId });
      } catch (err) {
        return c.json({ error: toErrorMessage(err) }, 400);
      }
    });

  return app;
}
