/**
 * Workflow graph validation — structural rules the engine relies on.
 *
 * The graph must be a DAG (return loops are runtime behavior, not edges);
 * the deliverable node is the single mutation sink; blackboard references may
 * only point at ancestors, so every input is guaranteed resolvable when the
 * node becomes ready.
 */

import { z } from 'zod';
import { INPUT_REF_PATTERN, NODE_ID_PATTERN } from './blackboard.js';
import {
  WORKFLOW_BUDGET_DEFAULTS,
  WORKFLOW_BUDGET_LIMITS,
  WORKFLOW_NODE_POLICY_LIMITS,
  WORKFLOW_ROLE_ADDENDUM_MAX_CHARS,
  type WorkflowBudget,
  type WorkflowGraph,
} from '@greenhouse/types/workflow';

// ─── Shape schema (zod) ──────────────────────────────────

const briefSchema = z.object({
  objective: z.string().min(1),
  inputs: z.record(z.string(), z.string()).optional(),
  output_schema: z.record(z.string(), z.enum(['string', 'number', 'boolean', 'array', 'object', 'any'])).optional(),
  boundaries: z.string().optional(),
  end_on: z.string().optional(),
});

const nodeSchema = z.object({
  id: z
    .string()
    .regex(NODE_ID_PATTERN, 'node id must be lowercase letters, digits, "-" or "_", starting with a letter or digit'),
  agent: z.string().min(1),
  brief: briefSchema,
  role_addendum: z.string().max(WORKFLOW_ROLE_ADDENDUM_MAX_CHARS).optional(),
  depends_on: z.array(z.string()).optional(),
  gates: z
    .object({
      before: z.enum(['none', 'human']).optional(),
      after: z.enum(['auto', 'checks', 'human']).optional(),
    })
    .optional(),
  checks: z
    .array(
      z.union([
        z.object({ type: z.literal('schema') }),
        z.object({ type: z.literal('reviewer'), agent: z.string().optional(), criteria: z.string().optional() }),
      ]),
    )
    .optional(),
  policy: z
    .object({
      timeout_ms: z.number().int().positive().optional(),
      max_retry: z.number().int().min(0).optional(),
      max_return: z.number().int().min(0).optional(),
      max_steps: z.number().int().positive().optional(),
    })
    .optional(),
});

const graphSchema = z.object({
  nodes: z.array(nodeSchema),
  deliverable_node: z.string(),
  budget: z
    .object({
      max_nodes: z.number().int().positive().optional(),
      concurrency: z.number().int().positive().optional(),
      max_tokens: z.number().int().positive().optional(),
    })
    .optional(),
});

// ─── Semantic validation ─────────────────────────────────

/** Shared with the resolver — see NODE_ID_PATTERN's note on why there is one copy. */
const INPUT_REF = INPUT_REF_PATTERN;

/** Returns a list of human-readable problems; empty = valid. */
export function validateWorkflowGraph(graph: WorkflowGraph): string[] {
  const shape = graphSchema.safeParse(graph);
  if (!shape.success) {
    return shape.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  }

  const errors: string[] = [];
  const budget = resolveBudget(graph.budget);

  if (graph.nodes.length === 0) errors.push('graph has no nodes');
  if (graph.nodes.length > budget.max_nodes) {
    errors.push(`node count ${graph.nodes.length} exceeds budget max_nodes ${budget.max_nodes}`);
  }
  if (budget.max_nodes > WORKFLOW_BUDGET_LIMITS.max_nodes) {
    errors.push(`budget max_nodes exceeds hard limit ${WORKFLOW_BUDGET_LIMITS.max_nodes}`);
  }
  if (budget.concurrency > WORKFLOW_BUDGET_LIMITS.concurrency) {
    errors.push(`budget concurrency exceeds hard limit ${WORKFLOW_BUDGET_LIMITS.concurrency}`);
  }
  if (budget.max_tokens > WORKFLOW_BUDGET_LIMITS.max_tokens) {
    errors.push(`budget max_tokens exceeds hard limit ${WORKFLOW_BUDGET_LIMITS.max_tokens}`);
  }

  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    ids.add(node.id);
  }

  for (const node of graph.nodes) {
    for (const dep of node.depends_on ?? []) {
      if (!ids.has(dep)) errors.push(`node ${node.id} depends on unknown node: ${dep}`);
    }
    const policy = node.policy ?? {};
    for (const key of ['timeout_ms', 'max_retry', 'max_return', 'max_steps'] as const) {
      const v = policy[key];
      if (v !== undefined && v > WORKFLOW_NODE_POLICY_LIMITS[key]) {
        errors.push(`node ${node.id} policy ${key}=${v} exceeds limit ${WORKFLOW_NODE_POLICY_LIMITS[key]}`);
      }
    }
    if (node.role_addendum && node.role_addendum.length > WORKFLOW_ROLE_ADDENDUM_MAX_CHARS) {
      errors.push(`node ${node.id} role_addendum exceeds ${WORKFLOW_ROLE_ADDENDUM_MAX_CHARS} chars`);
    }
  }
  if (errors.length > 0) return errors; // structural problems make the checks below unreliable

  // Cycle check via Kahn's algorithm.
  const order = tryTopoOrder(graph);
  if (!order) {
    errors.push('graph contains a cycle');
    return errors;
  }

  // Deliverable: must exist and be a sink (no dependents).
  if (!ids.has(graph.deliverable_node)) {
    errors.push(`deliverable_node ${graph.deliverable_node} does not exist`);
  } else {
    const dependents = graph.nodes.filter((n) => (n.depends_on ?? []).includes(graph.deliverable_node));
    if (dependents.length > 0) {
      errors.push(
        `deliverable_node ${graph.deliverable_node} must be a sink but has dependents: ${dependents.map((n) => n.id).join(', ')}`,
      );
    }
  }

  // Blackboard references must target ancestors (guaranteed resolved at run time).
  for (const node of graph.nodes) {
    const ancestors = ancestorsOf(graph, node.id);
    for (const [name, ref] of Object.entries(node.brief.inputs ?? {})) {
      if (!ref.startsWith('$')) continue; // literal
      if (ref === '$run.input') continue;
      const m = INPUT_REF.exec(ref);
      if (!m) {
        errors.push(`node ${node.id} input ${name} has malformed reference: ${ref}`);
        continue;
      }
      const target = m[1]!;
      if (!ids.has(target)) {
        errors.push(`node ${node.id} input ${name} references unknown node: ${target}`);
      } else if (!ancestors.has(target)) {
        errors.push(`node ${node.id} input ${name} references ${target}, which is not an ancestor`);
      }
    }
  }

  return errors;
}

/** Parse graph JSON and assert validity; throws with all problems joined. */
export function parseWorkflowGraph(raw: string): WorkflowGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('workflow graph is not valid JSON');
  }
  const shape = graphSchema.safeParse(parsed);
  if (!shape.success) {
    throw new Error(
      `invalid workflow graph: ${shape.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const graph = shape.data as WorkflowGraph;
  const errors = validateWorkflowGraph(graph);
  if (errors.length > 0) throw new Error(`invalid workflow graph: ${errors.join('; ')}`);
  return graph;
}

export function resolveBudget(partial?: Partial<WorkflowBudget>): WorkflowBudget {
  return { ...WORKFLOW_BUDGET_DEFAULTS, ...(partial ?? {}) };
}

// ─── Graph helpers ───────────────────────────────────────

function tryTopoOrder(graph: WorkflowGraph): string[] | null {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes) {
    indegree.set(node.id, (node.depends_on ?? []).length);
    for (const dep of node.depends_on ?? []) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), node.id]);
    }
  }
  const queue = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const deg = indegree.get(next)! - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  return order.length === graph.nodes.length ? order : null;
}

/** Topological order; throws on cycles (call validate first). */
export function topoOrder(graph: WorkflowGraph): string[] {
  const order = tryTopoOrder(graph);
  if (!order) throw new Error('graph contains a cycle');
  return order;
}

/** Transitive ancestors (all upstream nodes) of a node. */
export function ancestorsOf(graph: WorkflowGraph, nodeId: string): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [...(byId.get(nodeId)?.depends_on ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.depends_on ?? []));
  }
  return seen;
}
