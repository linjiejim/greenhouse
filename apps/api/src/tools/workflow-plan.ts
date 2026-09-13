/**
 * Workflow Plan tool — the planner drafts / revises a workflow graph in chat.
 *
 * Session-scoped (needs a conversation to anchor the draft to) and DRAFT-ONLY:
 * this tool never starts execution. It validates + persists the graph and
 * returns a `workflow_plan` artifact the web renders as an editable plan card;
 * execution starts only through POST /api/workflows/:id/confirm — the human
 * confirm gate is a hard boundary the model cannot cross.
 *
 * The planner methodology lives in this tool's DESCRIPTION, not in a profile
 * prompt: the tool is assembled in every super session, so the description
 * reaches every eligible assembly surface — and when the `sprouty-workflows` preset was
 * retired (2026-08-01) its prompt had nowhere else correct to go.
 *
 * The only state this tool may write is THIS conversation's unexecuted draft
 * (see resolveEditableDraft). Anything already confirmed is frozen: a plan the
 * user approved must keep meaning what they approved.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import type { WorkflowGraph, WorkflowPlanArtifact } from '@greenhouse/types/workflow';
import { validateWorkflowGraph, resolveBudget } from '../workflow-engine/graph.js';
import { loadProfile, listProfileIds, normalizeProfileId } from '../profile.js';
import { sanitizeForPrompt } from '../security.js';
import { defineTool, type ToolMeta } from './define.js';

const meta: ToolMeta = {
  id: 'workflow_plan',
  name: 'Workflow Plan',
  brief: 'Draft or revise a multi-agent workflow graph for user confirmation',
  description: `Draft (action="draft") or revise (action="update", with workflow_id) a multi-agent workflow graph, for the user to confirm.

WHEN TO USE — only when ALL of these hold:
- the task genuinely needs several agents working on separate areas, or several long steps;
- the user has agreed to orchestrate it (they asked for a workflow/plan, or accepted your offer to build one).
Otherwise just answer. A question you can answer, a single search, a single document — do it directly; a workflow costs several times the tokens and makes the user wait. If a task looks big but you are unsure it is worth orchestrating, ASK first, then draft.

WHAT IT DOES: saves a DRAFT and shows the user an editable plan card. Execution starts ONLY after the user clicks Confirm — never say the workflow is running, and never promise results from it in the same turn.

The graph is a DAG of agent nodes:

{
  "nodes": [{
    "id": "short-id",
    "agent": "<profile id, e.g. team>",
    "brief": {
      "objective": "what this node must accomplish (self-contained)",
      "inputs": { "name": "$run.input" | "$nodes.<upstream-id>.outputs.<path>" | "literal" },
      "output_schema": { "field": "string|number|boolean|array|object|any" },
      "boundaries": "what it must NOT do",
      "end_on": "success criteria"
    },
    "role_addendum": "optional behavior addendum (≤500 chars)",
    "depends_on": ["upstream-id"],
    "gates": { "before": "none|human", "after": "auto|human" },
    "checks": [{ "type": "reviewer", "criteria": "..." }],
    "policy": { "max_retry": 1, "max_return": 1, "max_steps": 20 }
  }],
  "deliverable_node": "<the single final node — only it may write to CRM/KB etc.>"
}

DESIGN RULES
- Split by CONTEXT, not by phase: cut only where contexts genuinely don't overlap (separate research areas, different data domains). One artifact's draft→revise→finalize MUST stay in one node — splitting it is a game of telephone.
- Reads parallel, writes single-threaded: independent nodes run concurrently; every outward write (CRM/KB/files) happens only in the deliverable node.
- Delegation is a contract: each brief must be SELF-CONTAINED — objective, inputs, boundaries, done-when. A node sees nothing of this conversation. Vague briefs are the number-one cause of multi-agent failure.
- Fewer nodes beat more (default ≤8). If one node can do it, don't make three; if plain conversation can do it, say so instead of drafting.
- Structure intermediate output with \`output_schema\`; downstream nodes reference \`$nodes.<id>.outputs.<path>\`.
- \`agent\` defaults to \`team\`; a user's own profile is \`custom:<id>\`. Reviewers default to \`team\` with the bar written into \`criteria\`.

GATES — describe the graph EXACTLY, never more than it says. Three fields decide who checks the work:
- \`checks: [{type:"reviewer", criteria}]\` = an AI review. Not human approval. On failure the node re-runs with feedback.
- \`gates.after: "auto"|"checks"\` = NO human involvement ("checks" only means the declared reviewer decides).
- \`gates.after: "human"\` = a person approves or rejects; the run pauses for them.
- \`policy.max_return\` caps the rejection loop before it escalates to a human.

When the user says "I'll decide / I want to review it / send it back if it's wrong", that is \`gates.after: "human"\`. Adding only a reviewer check and then telling them they can approve or reject MISSTATES what the system will do — worse than adding no gate at all.`,
  category: 'admin',
  is_global: false,
  icon: 'Workflow',
  runtime_risk: 'r1',
  sort_order: 33,
  presentation: 'artifact',
};

const briefSchema = z.object({
  objective: z.string().min(1).max(2000),
  inputs: z.record(z.string(), z.string()).optional(),
  output_schema: z.record(z.string(), z.enum(['string', 'number', 'boolean', 'array', 'object', 'any'])).optional(),
  boundaries: z.string().max(2000).optional(),
  end_on: z.string().max(1000).optional(),
});

const nodeSchema = z.object({
  id: z.string(),
  agent: z.string(),
  brief: briefSchema,
  role_addendum: z.string().max(500).optional(),
  depends_on: z.array(z.string()).optional(),
  gates: z
    .object({ before: z.enum(['none', 'human']).optional(), after: z.enum(['auto', 'checks', 'human']).optional() })
    .optional(),
  checks: z
    .array(
      z.union([
        z.object({ type: z.literal('schema') }),
        z.object({
          type: z.literal('reviewer'),
          agent: z.string().optional(),
          criteria: z.string().max(1000).optional(),
        }),
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

const planSchema = z.object({
  action: z.enum(['draft', 'update']).describe('draft = create a new workflow; update = revise an existing one.'),
  workflow_id: z
    .number()
    .int()
    .optional()
    .describe('For action="update": the id of THIS conversation\'s draft (from your previous plan card).'),
  name: z.string().min(1).max(120).describe('Short workflow name shown on the plan card.'),
  task_input: z
    .string()
    .min(1)
    .max(8000)
    .describe('The user task statement, restated faithfully — becomes $run.input for the nodes.'),
  graph: z.object({
    nodes: z.array(nodeSchema).min(1),
    deliverable_node: z.string(),
    budget: z
      .object({
        max_nodes: z.number().int().positive().optional(),
        concurrency: z.number().int().positive().optional(),
        max_tokens: z.number().int().positive().optional(),
      })
      .optional(),
  }),
});

type PlanInput = z.infer<typeof planSchema>;

export interface WorkflowPlanContext {
  userId: string;
  sessionId: string;
}

/** Validate every node's agent id against loadable, non-hidden profiles. */
async function validateAgents(db: DatabaseProvider, userId: string, graph: WorkflowGraph): Promise<string[]> {
  const errors: string[] = [];
  const systemIds = new Set(listProfileIds());
  for (const node of graph.nodes) {
    const agents = [node.agent, ...(node.checks ?? []).map((c) => (c.type === 'reviewer' ? c.agent : undefined))];
    for (const agent of agents) {
      if (!agent) continue;
      if (agent.startsWith('custom:')) {
        const id = Number.parseInt(agent.slice(7), 10);
        const row = Number.isNaN(id) ? undefined : await db.customProfiles.getById(id);
        if (!row || (row.user_id !== userId && !row.is_shared)) {
          errors.push(`node ${node.id}: custom profile ${agent} not found or not accessible`);
        }
        continue;
      }
      // Graphs stored before the preset rename still say `team`; resolve the
      // same way the executor will rather than failing a run that would work.
      const resolved = normalizeProfileId(agent) ?? agent;
      if (!systemIds.has(resolved)) {
        errors.push(`node ${node.id}: unknown agent profile ${agent}`);
        continue;
      }
      const profile = loadProfile(resolved);
      if (profile.access.level === 'hidden') {
        errors.push(`node ${node.id}: profile ${agent} cannot be used as a workflow node`);
      }
    }
  }
  return errors;
}

/** Sanitize the prompt-bound free-text fields in place. */
function sanitizeGraph(graph: WorkflowGraph): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      role_addendum: node.role_addendum ? sanitizeForPrompt(node.role_addendum) : undefined,
      brief: {
        ...node.brief,
        objective: sanitizeForPrompt(node.brief.objective),
        boundaries: node.brief.boundaries ? sanitizeForPrompt(node.brief.boundaries) : undefined,
        end_on: node.brief.end_on ? sanitizeForPrompt(node.brief.end_on) : undefined,
      },
    })),
  };
}

/**
 * Resolve what `action="update"` is allowed to overwrite.
 *
 * The model supplies `workflow_id`, and a model-supplied id is a capability it
 * must not have: it can name any number, including a workflow another session
 * already confirmed and executed. So the target is resolved from THIS session
 * instead, and only while the draft is still unexecuted — once a plan has been
 * confirmed, its definition is frozen and a revision must be a new draft, or
 * the confirm gate would be retroactively meaningless and finished runs would
 * be rewritten under the user's feet.
 */
async function resolveEditableDraft(
  db: DatabaseProvider,
  ctx: WorkflowPlanContext,
  requestedId?: number,
): Promise<{ workflow: { id: number } } | { error: string }> {
  const mine = await db.workflows.listBySession(ctx.userId, ctx.sessionId);
  const editable = mine.find((w) => w.status === 'draft');
  if (!editable) {
    return {
      error:
        'no editable draft in this conversation (a confirmed plan is frozen — its runs must stay reproducible). Use action="draft" to propose a new one.',
    };
  }
  if (requestedId != null && requestedId !== editable.id) {
    return {
      error: `workflow ${requestedId} is not this conversation's draft — the editable draft is ${editable.id}. Retry with workflow_id=${editable.id}, or use action="draft".`,
    };
  }
  const runs = await db.workflows.listRunsByWorkflow(editable.id);
  if (runs.length > 0) {
    return { error: 'this plan has already been executed — use action="draft" to propose a revised workflow.' };
  }
  return { workflow: { id: editable.id } };
}

export function createWorkflowPlanTool(db: DatabaseProvider, ctx: WorkflowPlanContext) {
  return tool({
    description: meta.description,
    inputSchema: planSchema,
    execute: async (input: PlanInput) => {
      try {
        const graph = sanitizeGraph(input.graph as WorkflowGraph);
        const structural = validateWorkflowGraph(graph);
        if (structural.length > 0) {
          return { error: `invalid graph: ${structural.join('; ')}` };
        }
        const agentErrors = await validateAgents(db, ctx.userId, graph);
        if (agentErrors.length > 0) {
          return { error: `invalid agents: ${agentErrors.join('; ')}` };
        }

        let row;
        if (input.action === 'update') {
          const target = await resolveEditableDraft(db, ctx, input.workflow_id);
          if ('error' in target) return target;
          row = await db.workflows.update(target.workflow.id, {
            name: input.name,
            graph: JSON.stringify(graph),
            bumpVersion: true,
          });
        } else {
          row = await db.workflows.create({
            user_id: ctx.userId,
            name: input.name,
            graph: JSON.stringify(graph),
            created_from_session_id: ctx.sessionId,
          });
        }
        if (!row) return { error: 'failed to persist workflow' };

        const artifact: WorkflowPlanArtifact = {
          type: 'workflow_plan',
          workflow_id: row.id,
          version: row.version,
          name: row.name,
          task_input: sanitizeForPrompt(input.task_input),
          graph,
          budget: resolveBudget(graph.budget),
        };
        return artifact;
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
}

export const workflowPlanTool = defineTool({ meta, kind: 'lazy' });
