/**
 * Drizzle schema — Workflow graph engine tables (PostgreSQL).
 *
 * Tables: workflows, workflow_runs, workflow_node_runs, workflow_gates
 *
 * A workflow is a user-confirmed task graph whose nodes are agent-profile
 * executions (design: docs/specs/20260728-workflow-graph-engine.md).
 * The definition (graph JSON) lives on `workflows` and is versioned; runtime
 * state lives in `workflow_runs` / `workflow_node_runs` (the DB rows ARE the
 * engine's checkpoints — the boot sweep resumes from them after a restart).
 * `workflow_gates` persists human-in-the-loop approvals so a pending gate
 * survives restarts. Node executions link to sessions (channel='workflow')
 * via session_id as a logical relation (no FK — sessions are user-deletable).
 */

import { pgTable, serial, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './user.js';

// ─── workflows ───────────────────────────────────────────

export const workflows = pgTable(
  'workflows',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status', { enum: ['draft', 'confirmed', 'archived'] })
      .notNull()
      .default('draft'),
    /** Bumped on every structural revision (bounded-replan anchor). */
    version: integer('version').notNull().default(1),
    /** WorkflowGraph JSON (@greenhouse/types/workflow). */
    graph: text('graph').notNull().default('{}'),
    /** Chat session the plan was drafted in (logical relation, no FK). */
    created_from_session_id: text('created_from_session_id'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_workflows_user').on(table.user_id)],
);

// ─── workflow_runs ───────────────────────────────────────

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: text('id').primaryKey(),
    workflow_id: integer('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    workflow_version: integer('workflow_version').notNull(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // TS-level enum only (pg `text` emits no CHECK), so adding a status needs no migration.
    status: text('status', { enum: ['running', 'paused', 'paused_for_gate', 'completed', 'failed', 'canceled'] })
      .notNull()
      .default('running'),
    /** The user's original task statement ($run.input blackboard source). */
    task_input: text('task_input').notNull(),
    /**
     * The graph AS CONFIRMED, frozen for this run. The definition row can be
     * revised afterwards; a finished run must still show what it executed.
     * Null only for runs created before this column existed.
     */
    graph: text('graph'),
    /** WorkflowBudget JSON, frozen at confirm time. */
    budget: text('budget').notNull().default('{}'),
    total: integer('total').notNull().default(0),
    completed: integer('completed').notNull().default(0),
    tokens_used: integer('tokens_used').notNull().default(0),
    summary: text('summary'),
    error: text('error'),
    started_at: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    finished_at: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_workflow_runs_workflow').on(table.workflow_id),
    index('idx_workflow_runs_user').on(table.user_id),
    index('idx_workflow_runs_status').on(table.status),
  ],
);

// ─── workflow_node_runs ──────────────────────────────────

export const workflowNodeRuns = pgTable(
  'workflow_node_runs',
  {
    id: serial('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    node_id: text('node_id').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: text('status', {
      enum: ['pending', 'running', 'awaiting_gate', 'passed', 'failed', 'skipped', 'returned'],
    })
      .notNull()
      .default('pending'),
    /** The node's execution session (channel='workflow'; logical relation, no FK). */
    session_id: text('session_id'),
    /** Resolved blackboard inputs JSON (what the node was actually given). */
    inputs: text('inputs').notNull().default('{}'),
    /** Structured outputs JSON (validated against brief.output_schema). */
    outputs: text('outputs'),
    /** Check results JSON: schema pass/fail, reviewer verdict + feedback. */
    checks_result: text('checks_result'),
    error: text('error'),
    tokens: integer('tokens'),
    duration_ms: integer('duration_ms'),
    started_at: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    finished_at: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_workflow_node_runs_run').on(table.run_id),
    index('idx_workflow_node_runs_run_node').on(table.run_id, table.node_id),
  ],
);

// ─── workflow_gates ──────────────────────────────────────

export const workflowGates = pgTable(
  'workflow_gates',
  {
    id: serial('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => workflowRuns.id, { onDelete: 'cascade' }),
    /** Null for run-level gates (confirm_plan, budget escalation). */
    node_id: text('node_id'),
    kind: text('kind', { enum: ['confirm_plan', 'before_node', 'after_node', 'escalation'] }).notNull(),
    /** Context for the approval UI (reason, node outputs, escalation options). */
    payload: text('payload').notNull().default('{}'),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    decided_by: text('decided_by'),
    note: text('note'),
    decided_at: timestamp('decided_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_workflow_gates_run').on(table.run_id), index('idx_workflow_gates_status').on(table.status)],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type WorkflowNodeRunRow = typeof workflowNodeRuns.$inferSelect;
export type WorkflowGateRow = typeof workflowGates.$inferSelect;
