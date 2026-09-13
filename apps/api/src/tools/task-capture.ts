/**
 * Task Capture — the model drafts a reusable Task from THIS conversation.
 *
 * Session-scoped and DRAFT-ONLY, the same shape as `mission_dispatch` and
 * `workflow_plan`: it writes no row. It returns a `task_capture` artifact the
 * web renders as an editable card, and the Task exists only once the user
 * presses Create (POST /api/prompts) — spec D2.
 *
 * The confirm gate is the point of the feature, not ceremony around it. The
 * user asked to freeze a flow they just watched work; a Task the model saved
 * on its own would be a flow nobody checked, invoked by `/` for months.
 *
 * The tool list is NOT the model's to claim. It is derived here from the tools
 * this conversation actually called, so the card cannot advertise a capability
 * the flow never used (spec D4).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { safeJsonParse } from '@greenhouse/utils/json';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { placeholdersIn, TASK_VARIABLE_LIMITS, type TaskVariable } from '@greenhouse/types/tasks';
import { defineTool, type ToolMeta } from './define.js';

const MAX_BODY_CHARS = 8000;

const meta: ToolMeta = {
  id: 'task_capture',
  name: 'Task Capture',
  brief: 'Turn what we just did into a reusable Task',
  description: `Draft a reusable Task from THIS conversation, so the same flow can be re-run later from the \`/\` menu.

WHEN TO USE: the user asks to save, reuse or templatize a procedure that has actually worked here. Not for a single question you just answered.

Returns a card to review and edit — NOTHING is saved until they press Create, so never say the task exists in this turn.

\`content\` is the whole instruction set for a future run, in the user's language, written as if starting fresh: a later run cannot see this conversation. Give the steps in order, the data to look at, and the shape of the output.

Anything that would differ next time (a customer, a month) becomes a \`{{placeholder}}\` in \`content\` AND an entry in \`variables\`; a variable with no placeholder is rejected. Values that never change belong hard-coded, not as variables.`,
  category: 'core',
  is_global: true,
  builtin: true,
  icon: 'Bookmark',
  sort_order: 36,
  presentation: 'artifact',
};

const variableSchema = z.object({
  key: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/)
    .describe('Placeholder name; must appear in the body as {{key}}.'),
  label: z.string().min(1).max(TASK_VARIABLE_LIMITS.maxLabelLength).describe("Field label in the user's language."),
  required: z.boolean().optional(),
  example: z.string().max(TASK_VARIABLE_LIMITS.maxExampleLength).optional().describe('A concrete sample value.'),
});

const captureSchema = z.object({
  title: z.string().min(1).max(120).describe('Short task name shown in the / menu.'),
  description: z.string().max(300).optional().describe('One line on what this task is for.'),
  content: z.string().min(1).max(MAX_BODY_CHARS).describe('The full instructions for a future run.'),
  variables: z.array(variableSchema).max(TASK_VARIABLE_LIMITS.maxVariables).optional(),
});

type CaptureInput = z.infer<typeof captureSchema>;

/** Artifact payload consumed by the web TaskCaptureCard. */
export interface TaskCaptureArtifact {
  type: 'task_capture';
  title: string;
  description?: string;
  content: string;
  variables: TaskVariable[];
  /** Tool ids this conversation actually used — derived, never model-supplied. */
  expected_tools: string[];
  source_session_id: string;
}

export interface TaskCaptureContext {
  userId: string;
  sessionId: string;
}

/**
 * Tool ids this conversation actually called, in first-use order.
 *
 * Read from the persisted pipeline rather than asked of the model: the model
 * would be reconstructing from memory, and the whole value of the field is
 * that it reports what the flow really needed. Bookkeeping tools are dropped —
 * "this task needs task_capture" is noise.
 */
const NOT_PART_OF_A_FLOW = new Set(['task_capture', 'ask_user', 'memory', 'log_friction']);

async function toolsUsedIn(db: DatabaseProvider, sessionId: string): Promise<string[]> {
  const messages = await db.sessions.getMessages(sessionId);
  const used: string[] = [];
  for (const message of messages) {
    const pipeline = safeJsonParse(message.pipeline, []);
    if (!Array.isArray(pipeline)) continue;
    for (const raw of pipeline) {
      const step = raw as { tool?: unknown; name?: unknown } | null;
      const id = typeof step?.tool === 'string' ? step.tool : typeof step?.name === 'string' ? step.name : null;
      if (id && !NOT_PART_OF_A_FLOW.has(id) && !used.includes(id)) used.push(id);
    }
  }
  return used;
}

export function createTaskCaptureTool(db: DatabaseProvider, ctx: TaskCaptureContext) {
  return tool({
    description: meta.description,
    inputSchema: captureSchema,
    execute: async (input: CaptureInput): Promise<TaskCaptureArtifact | { error: string }> => {
      try {
        const content = input.content.trim();
        if (!content) return { error: 'content is required' };

        const variables = input.variables ?? [];
        const present = placeholdersIn(content);
        // Rejected rather than silently dropped: a variable with no
        // placeholder renders a form field that changes nothing, and the user
        // has no way to see that from the card.
        const orphan = variables.find((v) => !present.includes(v.key));
        if (orphan) {
          return {
            error:
              `variable "${orphan.key}" is declared but {{${orphan.key}}} does not appear in the body — ` +
              `add the placeholder where the value belongs, or drop the variable`,
          };
        }
        const duplicate = variables.find((v, i) => variables.findIndex((o) => o.key === v.key) !== i);
        if (duplicate) return { error: `duplicate variable key: ${duplicate.key}` };

        return {
          type: 'task_capture',
          title: input.title.trim(),
          ...(input.description?.trim() ? { description: input.description.trim() } : {}),
          content,
          variables,
          expected_tools: await toolsUsedIn(db, ctx.sessionId),
          source_session_id: ctx.sessionId,
        };
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
}

export const taskCaptureTool = defineTool({ meta, kind: 'lazy' });
