/**
 * Workflow graph types — shared across DB, engine, API and web layers.
 *
 * A workflow is a user-confirmed task graph whose nodes are agent-profile
 * executions. The GRAPH DEFINITION (this file's WorkflowGraph) is versioned and
 * immutable per run; RUNTIME observations (attempts, durations, tokens) live in
 * workflow_node_runs rows, never in the definition.
 *
 * Design spec: docs/specs/20260728-workflow-graph-engine.md
 */

// ─── Statuses ────────────────────────────────────────────

export type WorkflowStatus = 'draft' | 'confirmed' | 'archived';

/** `paused` = user stop (in-flight nodes finish); `paused_for_gate` = engine waiting on a human decision. */
export type WorkflowRunStatus = 'running' | 'paused' | 'paused_for_gate' | 'completed' | 'failed' | 'canceled';

export type WorkflowNodeRunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_gate'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'returned';

export type WorkflowGateKind = 'confirm_plan' | 'before_node' | 'after_node' | 'escalation';

export type WorkflowGateStatus = 'pending' | 'approved' | 'rejected';

/** What the human chose on an escalation gate. */
export type WorkflowEscalationDecision = 'retry' | 'skip' | 'abort';

// ─── Graph definition ────────────────────────────────────

export interface WorkflowNodeBrief {
  /** What this node must accomplish — the core of the delegation contract. */
  objective: string;
  /**
   * Named inputs rendered into the node prompt. Values are either literals or
   * blackboard references: "$run.input" (the user's task statement) or
   * "$nodes.<nodeId>.outputs.<dot.path>" (an upstream node's structured output).
   */
  inputs?: Record<string, string>;
  /**
   * Simplified output schema: field name → expected type. The node must end
   * with a fenced JSON object satisfying it. (Deliberately NOT full JSON
   * Schema — planner-authored schemas stay simple and checkable without ajv.)
   */
  output_schema?: Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any'>;
  /** Explicit boundaries — what the node must NOT do. */
  boundaries?: string;
  /** Success / termination criteria (also shown to the model). */
  end_on?: string;
}

export interface WorkflowNodeGates {
  /** Human approval required before the node starts. Default 'none'. */
  before?: 'none' | 'human';
  /** How the node's output is accepted. Default 'auto'. */
  after?: 'auto' | 'checks' | 'human';
}

export type WorkflowNodeCheck = { type: 'schema' } | { type: 'reviewer'; agent?: string; criteria?: string };

export interface WorkflowNodePolicy {
  timeout_ms?: number;
  max_retry?: number;
  /** Max reviewer-driven re-runs (the bounded back-and-forth loop). */
  max_return?: number;
  max_steps?: number;
}

export interface WorkflowNode {
  /** Stable node id within the graph, kebab-case. */
  id: string;
  /** Agent profile executing this node: a system profile id or `custom:<n>`. */
  agent: string;
  brief: WorkflowNodeBrief;
  /**
   * Optional behavioral addendum APPENDED to the profile's system prompt
   * (never replacing it). Human-reviewed at plan confirmation. Max 500 chars.
   */
  role_addendum?: string;
  /** Upstream node ids. Parallelism is fully derived from this. */
  depends_on?: string[];
  gates?: WorkflowNodeGates;
  checks?: WorkflowNodeCheck[];
  policy?: WorkflowNodePolicy;
}

export interface WorkflowBudget {
  max_nodes: number;
  concurrency: number;
  max_tokens: number;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  /**
   * The single mutation sink: only this node may call mutating tools
   * (writes single-threaded principle). Must be a sink of the DAG.
   */
  deliverable_node: string;
  budget?: Partial<WorkflowBudget>;
}

// ─── Defaults & hard limits (user-adjustable on the confirm card) ──

export const WORKFLOW_BUDGET_DEFAULTS: WorkflowBudget = {
  max_nodes: 8,
  concurrency: 3,
  max_tokens: 1_000_000,
};

export const WORKFLOW_BUDGET_LIMITS: WorkflowBudget = {
  max_nodes: 15,
  concurrency: 5,
  max_tokens: 5_000_000,
};

export const WORKFLOW_NODE_POLICY_DEFAULTS: Required<WorkflowNodePolicy> = {
  timeout_ms: 600_000,
  max_retry: 1,
  max_return: 1,
  max_steps: 20,
};

export const WORKFLOW_NODE_POLICY_LIMITS: Required<WorkflowNodePolicy> = {
  timeout_ms: 1_800_000,
  max_retry: 3,
  max_return: 3,
  max_steps: 30,
};

export const WORKFLOW_ROLE_ADDENDUM_MAX_CHARS = 500;

// ─── Runtime views (API responses & artifact card payloads) ──

export interface WorkflowGateView {
  id: number;
  node_id: string | null;
  kind: WorkflowGateKind;
  status: WorkflowGateStatus;
  payload: Record<string, unknown>;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface WorkflowNodeRunView {
  id: number;
  node_id: string;
  attempt: number;
  status: WorkflowNodeRunStatus;
  session_id: string | null;
  /** Blackboard references resolved to their actual values — the debug view. */
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  checks_result: Record<string, unknown> | null;
  error: string | null;
  tokens: number | null;
  duration_ms: number | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface WorkflowRunView {
  id: string;
  workflow_id: number;
  /** Workflow name — the dock renders a run without loading the definition. */
  name: string;
  workflow_version: number;
  status: WorkflowRunStatus;
  task_input: string;
  budget: WorkflowBudget;
  tokens_used: number;
  total: number;
  completed: number;
  graph: WorkflowGraph;
  node_runs: WorkflowNodeRunView[];
  gates: WorkflowGateView[];
  summary: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * Split a run summary into the prose body and the remaining structured fields.
 *
 * The deliverable node's output_schema field names are planner-chosen, so the
 * dominant long string is treated as the report body and everything else is
 * kept as structured metadata rather than thrown away.
 *
 * Shared on purpose: the web deliverable panel renders from it and the engine
 * writes the same body into the conversation's outcome message — two copies of
 * this heuristic would let the chat message and the card disagree about what
 * the deliverable actually was.
 */
export function splitWorkflowSummary(summary: Record<string, unknown>): {
  body: string;
  rest: Record<string, unknown>;
} {
  const entries = Object.entries(summary);
  const stringEntries = entries.filter((e): e is [string, string] => typeof e[1] === 'string');
  const explicit = stringEntries.find(([k]) => k === 'text' || k === 'report' || k === 'markdown');
  const longest = [...stringEntries].sort((a, b) => b[1].length - a[1].length)[0];
  const chosen = explicit ?? (longest && longest[1].length >= 120 ? longest : undefined);
  if (!chosen) return { body: '', rest: summary };
  const rest = Object.fromEntries(entries.filter(([k]) => k !== chosen[0]));
  return { body: chosen[1], rest };
}

/** Artifact payload emitted by the workflow_plan tool (rendered as the plan card). */
export interface WorkflowPlanArtifact {
  type: 'workflow_plan';
  workflow_id: number;
  version: number;
  name: string;
  /** The user's task statement ($run.input) — editable on the confirm card. */
  task_input: string;
  graph: WorkflowGraph;
  budget: WorkflowBudget;
}
