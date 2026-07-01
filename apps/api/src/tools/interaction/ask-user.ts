/**
 * Ask User tool — interactive question form for gathering user input.
 *
 * When the Agent needs clarifications (preferences, decisions, confirmations),
 * it calls this tool to present an interactive form to the user.
 * The frontend renders the questions as a form card; the user fills in answers
 * and submits, which sends a structured user message back to the Agent.
 *
 * Access: internal profiles only (team, admin).
 */

import { tool } from 'ai';
import { z } from 'zod';
import { defineTool, type ToolMeta } from '../define.js';

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'ask_user',
  name: 'Ask User',
  brief: 'Ask the user clarifying questions',
  description: `Proactively ask the user for more information when the question is vague or needs more context.
Present clarifying questions as structured options to help users quickly choose.`,
  category: 'public',
  is_global: true,
  icon: 'ClipboardList',
  group: 'interaction',
  presentation: 'artifact', // renders as the interactive AskUserCard in the message body
};

const OptionSchema = z.object({
  value: z.string().describe('Option value (sent back to agent)'),
  label: z.string().describe('Display label for the option'),
});

const QuestionSchema = z.object({
  id: z.string().describe('Unique question identifier (e.g. "tone", "length")'),
  label: z.string().describe('Question text displayed to the user'),
  type: z
    .enum(['text', 'textarea', 'single_choice', 'multi_choice'])
    .describe('Input type: text (single-line), textarea (multi-line), single_choice (radio), multi_choice (checkbox)'),
  options: z.array(OptionSchema).optional().describe('Options for single_choice / multi_choice types'),
  required: z.boolean().optional().describe('Whether the question must be answered (default: true)'),
  placeholder: z.string().optional().describe('Placeholder text for text/textarea inputs'),
});

const askUserSchema = z.object({
  title: z.string().optional().describe('Form title, e.g. "Blog Post Preferences"'),
  description: z.string().optional().describe('Brief context explaining why you need this information'),
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
