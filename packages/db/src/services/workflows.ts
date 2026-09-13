/**
 * Workflow service — graph definitions, runs, node runs and gates (PostgreSQL).
 *
 * Thin CRUD over the workflow tables; ALL orchestration logic (ready-set
 * computation, retries, gates lifecycle) lives in apps/api/src/workflow-engine.
 * Row states double as the engine's checkpoints, so every mutation here must
 * be a single self-contained write (no in-memory-only state).
 */

import { and, asc, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { workflows, workflowRuns, workflowNodeRuns, workflowGates } from '../schema/index.js';
import type { WorkflowRow, WorkflowRunRow, WorkflowNodeRunRow, WorkflowGateRow } from '../schema/workflow.js';

export interface WorkflowCreateInput {
  user_id: string;
  name: string;
  graph: string;
  created_from_session_id?: string;
}

export interface WorkflowRunCreateInput {
  id: string;
  workflow_id: number;
  workflow_version: number;
  user_id: string;
  task_input: string;
  /** The confirmed graph, frozen for this run (see workflowRuns.graph). */
  graph: string;
  budget: string;
  total: number;
}

export interface WorkflowNodeRunCreateInput {
  run_id: string;
  node_id: string;
  attempt?: number;
  status?: WorkflowNodeRunRow['status'];
  inputs?: string;
}

export interface WorkflowGateCreateInput {
  run_id: string;
  node_id?: string | null;
  kind: WorkflowGateRow['kind'];
  payload?: string;
}

export interface WorkflowRunReconciliationCursor {
  created_at: string;
  id: string;
}

export interface WorkflowRunReconciliationPage {
  items: WorkflowRunRow[];
  next_cursor: WorkflowRunReconciliationCursor | null;
}

export function createWorkflowService(db: Db) {
  const service = {
    // ─── Definitions ─────────────────────────────────────

    async create(input: WorkflowCreateInput): Promise<WorkflowRow> {
      const now = nowIso();
      const [row] = await db
        .insert(workflows)
        .values({
          user_id: input.user_id,
          name: input.name,
          graph: input.graph,
          created_from_session_id: input.created_from_session_id ?? null,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async getById(id: number): Promise<WorkflowRow | undefined> {
      const rows = await db.select().from(workflows).where(eq(workflows.id, id));
      return rows[0];
    },

    async listByUser(userId: string): Promise<WorkflowRow[]> {
      return await db.select().from(workflows).where(eq(workflows.user_id, userId)).orderBy(desc(workflows.updated_at));
    },

    /** Workflows drafted in one chat session, newest first — scopes planner edits. */
    async listBySession(userId: string, sessionId: string): Promise<WorkflowRow[]> {
      return await db
        .select()
        .from(workflows)
        .where(and(eq(workflows.user_id, userId), eq(workflows.created_from_session_id, sessionId)))
        .orderBy(desc(workflows.id));
    },

    /** Update name/graph; bumpVersion marks a structural revision. */
    async update(
      id: number,
      updates: { name?: string; graph?: string; status?: WorkflowRow['status']; bumpVersion?: boolean },
    ): Promise<WorkflowRow | undefined> {
      const set: Record<string, unknown> = { updated_at: nowIso() };
      if (updates.name !== undefined) set.name = updates.name;
      if (updates.graph !== undefined) set.graph = updates.graph;
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.bumpVersion) set.version = sql`${workflows.version} + 1`;
      const [row] = await db.update(workflows).set(set).where(eq(workflows.id, id)).returning();
      return row;
    },

    // ─── Runs ────────────────────────────────────────────

    async createRun(input: WorkflowRunCreateInput): Promise<WorkflowRunRow> {
      const now = nowIso();
      const [row] = await db
        .insert(workflowRuns)
        .values({
          id: input.id,
          workflow_id: input.workflow_id,
          workflow_version: input.workflow_version,
          user_id: input.user_id,
          task_input: input.task_input,
          graph: input.graph,
          budget: input.budget,
          total: input.total,
          started_at: now,
          created_at: now,
        })
        .returning();
      return row!;
    },

    async getRun(id: string): Promise<WorkflowRunRow | undefined> {
      const rows = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id));
      return rows[0];
    },

    async listRunsByWorkflow(workflowId: number): Promise<WorkflowRunRow[]> {
      return await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.workflow_id, workflowId))
        .orderBy(desc(workflowRuns.created_at));
    },

    /** Stable all-owner scan used only by the Runtime read-model reconciler. */
    async listRunsForRuntimeReconciliation(
      input: {
        cursor?: WorkflowRunReconciliationCursor;
        limit?: number;
      } = {},
    ): Promise<WorkflowRunReconciliationPage> {
      const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
      const rows = await db
        .select()
        .from(workflowRuns)
        .where(
          input.cursor
            ? or(
                gt(workflowRuns.created_at, input.cursor.created_at),
                and(eq(workflowRuns.created_at, input.cursor.created_at), gt(workflowRuns.id, input.cursor.id)),
              )
            : undefined,
        )
        .orderBy(asc(workflowRuns.created_at), asc(workflowRuns.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const tail = items.at(-1);
      return {
        items,
        next_cursor: hasMore && tail ? { created_at: tail.created_at, id: tail.id } : null,
      };
    },

    /** Unfinished runs — the boot sweep resumes these after a restart. */
    async listActiveRuns(): Promise<WorkflowRunRow[]> {
      return await db
        .select()
        .from(workflowRuns)
        .where(inArray(workflowRuns.status, ['running', 'paused_for_gate']));
    },

    async listActiveRunsByUser(userId: string): Promise<WorkflowRunRow[]> {
      return await db
        .select()
        .from(workflowRuns)
        .where(
          and(eq(workflowRuns.user_id, userId), inArray(workflowRuns.status, ['running', 'paused', 'paused_for_gate'])),
        );
    },

    /**
     * Most recent run of the workflow drafted in a given chat session — the run
     * dock's data source (a session drafts at most one workflow in practice).
     */
    async findLatestRunBySession(userId: string, sessionId: string): Promise<WorkflowRunRow | undefined> {
      const rows = await db
        .select({ run: workflowRuns })
        .from(workflowRuns)
        .innerJoin(workflows, eq(workflows.id, workflowRuns.workflow_id))
        .where(and(eq(workflowRuns.user_id, userId), eq(workflows.created_from_session_id, sessionId)))
        .orderBy(desc(workflowRuns.created_at))
        .limit(1);
      return rows[0]?.run;
    },

    async updateRun(
      id: string,
      updates: {
        status?: WorkflowRunRow['status'];
        summary?: string;
        error?: string | null;
        finished_at?: string | null;
        completed?: number;
        budget?: string;
      },
    ): Promise<WorkflowRunRow | undefined> {
      const set: Record<string, unknown> = {};
      if (updates.status !== undefined) set.status = updates.status;
      if (updates.summary !== undefined) set.summary = updates.summary;
      if (updates.error !== undefined) set.error = updates.error;
      if (updates.finished_at !== undefined) set.finished_at = updates.finished_at;
      if (updates.completed !== undefined) set.completed = updates.completed;
      if (updates.budget !== undefined) set.budget = updates.budget;
      if (Object.keys(set).length === 0) return await service.getRun(id);
      const [row] = await db.update(workflowRuns).set(set).where(eq(workflowRuns.id, id)).returning();
      return row;
    },

    /**
     * Compare-and-set on the run status: the update only lands if the row is
     * still in one of `from`, and the caller that gets a row back is the one
     * that WON the transition.
     *
     * Terminal transitions have a side effect that must happen exactly once
     * (the conversation's outcome message), and cancel / drive-loop completion
     * / gate abort can race. An unconditional UPDATE would let two of them
     * both "finish" the same run and write the message twice — same reason
     * agent_runs.transitionRun exists on the Cloud Agent side.
     */
    async transitionRun(
      id: string,
      from: ReadonlyArray<WorkflowRunRow['status']>,
      updates: {
        status: WorkflowRunRow['status'];
        summary?: string;
        error?: string | null;
        finished_at?: string | null;
      },
    ): Promise<WorkflowRunRow | undefined> {
      const set: Record<string, unknown> = { status: updates.status };
      if (updates.summary !== undefined) set.summary = updates.summary;
      if (updates.error !== undefined) set.error = updates.error;
      if (updates.finished_at !== undefined) set.finished_at = updates.finished_at;
      const [row] = await db
        .update(workflowRuns)
        .set(set)
        .where(and(eq(workflowRuns.id, id), inArray(workflowRuns.status, [...from])))
        .returning();
      return row;
    },

    /** Atomic progress bump (node completion / token spend). */
    async bumpRunProgress(
      id: string,
      delta: { completed?: number; tokens?: number },
    ): Promise<WorkflowRunRow | undefined> {
      const [row] = await db
        .update(workflowRuns)
        .set({
          completed: sql`${workflowRuns.completed} + ${delta.completed ?? 0}`,
          tokens_used: sql`${workflowRuns.tokens_used} + ${delta.tokens ?? 0}`,
        })
        .where(eq(workflowRuns.id, id))
        .returning();
      return row;
    },

    // ─── Node runs ───────────────────────────────────────

    async createNodeRun(input: WorkflowNodeRunCreateInput): Promise<WorkflowNodeRunRow> {
      const [row] = await db
        .insert(workflowNodeRuns)
        .values({
          run_id: input.run_id,
          node_id: input.node_id,
          attempt: input.attempt ?? 1,
          status: input.status ?? 'pending',
          inputs: input.inputs ?? '{}',
          created_at: nowIso(),
        })
        .returning();
      return row!;
    },

    async getNodeRun(id: number): Promise<WorkflowNodeRunRow | undefined> {
      const rows = await db.select().from(workflowNodeRuns).where(eq(workflowNodeRuns.id, id));
      return rows[0];
    },

    /** All attempts for a run, oldest first (attempt order == insertion order). */
    async listNodeRuns(runId: string): Promise<WorkflowNodeRunRow[]> {
      return await db
        .select()
        .from(workflowNodeRuns)
        .where(eq(workflowNodeRuns.run_id, runId))
        .orderBy(workflowNodeRuns.id);
    },

    async updateNodeRun(
      id: number,
      updates: {
        status?: WorkflowNodeRunRow['status'];
        session_id?: string;
        inputs?: string;
        outputs?: string | null;
        checks_result?: string | null;
        error?: string | null;
        tokens?: number;
        duration_ms?: number;
        started_at?: string | null;
        finished_at?: string | null;
      },
    ): Promise<WorkflowNodeRunRow | undefined> {
      const set: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) set[k] = v;
      }
      if (Object.keys(set).length === 0) return await service.getNodeRun(id);
      const [row] = await db.update(workflowNodeRuns).set(set).where(eq(workflowNodeRuns.id, id)).returning();
      return row;
    },

    // ─── Gates ───────────────────────────────────────────

    async createGate(input: WorkflowGateCreateInput): Promise<WorkflowGateRow> {
      const [row] = await db
        .insert(workflowGates)
        .values({
          run_id: input.run_id,
          node_id: input.node_id ?? null,
          kind: input.kind,
          payload: input.payload ?? '{}',
          created_at: nowIso(),
        })
        .returning();
      return row!;
    },

    async getGate(id: number): Promise<WorkflowGateRow | undefined> {
      const rows = await db.select().from(workflowGates).where(eq(workflowGates.id, id));
      return rows[0];
    },

    async listGates(runId: string): Promise<WorkflowGateRow[]> {
      return await db.select().from(workflowGates).where(eq(workflowGates.run_id, runId)).orderBy(workflowGates.id);
    },

    async listPendingGates(runId: string): Promise<WorkflowGateRow[]> {
      return await db
        .select()
        .from(workflowGates)
        .where(and(eq(workflowGates.run_id, runId), eq(workflowGates.status, 'pending')))
        .orderBy(workflowGates.id);
    },

    /** Decide a gate; only pending gates can be decided (returns undefined otherwise). */
    async decideGate(
      id: number,
      decision: { status: 'approved' | 'rejected'; decided_by: string; note?: string },
    ): Promise<WorkflowGateRow | undefined> {
      const [row] = await db
        .update(workflowGates)
        .set({
          status: decision.status,
          decided_by: decision.decided_by,
          note: decision.note ?? null,
          decided_at: nowIso(),
        })
        .where(and(eq(workflowGates.id, id), eq(workflowGates.status, 'pending')))
        .returning();
      return row;
    },
  };
  return service;
}

export type WorkflowService = ReturnType<typeof createWorkflowService>;
