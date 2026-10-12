/**
 * Ask User tool — interactive question form for gathering user input.
 *
 * When the Agent needs clarifications (preferences, decisions, confirmations),
 * it calls this tool to present an interactive form to the user.
 * The frontend renders the questions as a form card; the user fills in answers
 * and submits, which sends a structured user message back to the Agent.
 *
 * Access: built-in internal profiles only.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { defineTool, type ToolMeta } from './define.js';

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'ask_user',
  name: 'Ask User',
  brief: 'Ask the user clarifying questions',
  description: `Ask only for missing information needed for the next step; reuse prior answers. Use the user's language, preferably 1–3 focused questions and 2–4 distinct options.
Labels name the choice (e.g. "安全填卡", "我自己注册"), ideally ≤12 Chinese characters or 6 English words; retain essential distinctions and consequences. Omit implementation details, assurances and repeated explanations. Add at most one supporting sentence if needed.
No generic "Anything else?", questions about later tasks, or passwords/codes; credentials go through secure login.`,
  category: 'core',
  is_global: true,
  builtin: true,
  icon: 'ClipboardList',
  sort_order: 5,
  presentation: 'artifact', // renders as the interactive AskUserCard in the message body
};

const OptionSchema = z.object({
  value: z.string().describe('Option value (sent back to agent)'),
  label: z
    .string()
    .describe('Concise choice name; preserve the distinction, omit commentary and implementation details'),
});

const QuestionSchema = z.object({
  id: z.string().describe('Unique question identifier (e.g. "tone", "length")'),
  label: z.string().describe('Short question asking one decision needed for the current step'),
  type: z
    .enum(['text', 'textarea', 'single_choice', 'multi_choice'])
    .describe('Input type: text (single-line), textarea (multi-line), single_choice (radio), multi_choice (checkbox)'),
  options: z.array(OptionSchema).optional().describe('Options for single_choice / multi_choice types'),
  required: z.boolean().optional().describe('Whether the question must be answered (default: true)'),
  placeholder: z.string().optional().describe('Placeholder text for text/textarea inputs'),
});

const askUserSchema = z.object({
  title: z.string().optional().describe('Form title, e.g. "Blog Post Preferences"'),
  description: z
    .string()
    .optional()
    .describe('Omit unless needed: one short sentence of supporting context; never repeat the title or options'),
  questions: z.array(QuestionSchema).min(1).max(10).describe('1–10 questions to ask the user'),
});

type AskUserInput = z.infer<typeof askUserSchema>;

export function createAskUserTool() {
  return tool({
    description: meta.description,
    inputSchema: askUserSchema,
    execute: async (input: AskUserInput) => {
      return {
        type: 'ask_user',
        status: 'pending_user_input',
        title: input.title || 'A few questions',
        description: input.description,
        questions: input.questions,
      };
    },
  });
}

export const askUserTool = defineTool({ meta, kind: 'static', create: () => createAskUserTool() });
