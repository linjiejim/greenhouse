/**
 * `bot_tasks` — background work that keeps going while the member chats
 * (spec §7).
 *
 * `start` only PROPOSES: it raises a task card (title + brief) and the task is
 * admitted when the member presses Start (POST /api/bots/requests/:id, the
 * member's own credentials). The model never holds an execution entry point
 * for unattended work. `list` and `cancel` are scoped to this conversation.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { BotTaskStartPayload } from '@greenhouse/types/bots';
import type { BotTurnContext } from '../engine/context.js';
import { BOT_TASK_BRIEF_MAX, BOT_TASK_TITLE_MAX, cancelBotTask, listConversationTasks } from '../engine/tasks.js';
import { BOT_TOOL_METAS } from './meta.js';

const DESCRIPTION = BOT_TOOL_METAS.find((meta) => meta.id === 'bot_tasks')?.description ?? 'bot_tasks';

const tasksSchema = z.object({
  action: z.enum(['start', 'list', 'cancel']).describe('start | list | cancel'),
  title: z.string().max(BOT_TASK_TITLE_MAX).optional().describe(`start: a short title (≤${BOT_TASK_TITLE_MAX} chars).`),
  brief: z
    .string()
    .max(BOT_TASK_BRIEF_MAX)
    .optional()
    .describe(
      `start: a self-contained brief (≤${BOT_TASK_BRIEF_MAX} chars) — the task starts with only this approved brief; reading conversation notes/history later disables all further browser actions: say what to find, where to look, and what the report should contain.`,
    ),
  run_id: z.string().max(80).optional().describe('cancel: the task run id from list.'),
});
type TasksInput = z.infer<typeof tasksSchema>;

export function createBotTasksTool(ctx: BotTurnContext) {
  return tool({
    description: DESCRIPTION,
    inputSchema: tasksSchema,
    execute: async (input: TasksInput) => {
      try {
        switch (input.action) {
          case 'start': {
            const title = input.title?.trim();
            const brief = input.brief?.trim();
            if (!title || !brief)
              return { action: 'start', status: 'refused', reason: 'title and brief are required.' };
            const payload: BotTaskStartPayload = { title, brief };
            const request = await ctx.createRequest('task_start', payload);
            return {
              action: 'start',
              status: 'proposed',
              request_id: request.id,
              note: 'The member sees a task card and starts it with one click. Tell them in one line what the task will do; it reports back here when done. You can keep helping meanwhile.',
            };
          }
          case 'list': {
            const tasks = await listConversationTasks(ctx.db, ctx.userId, ctx.sessionId);
            return {
              action: 'list',
              tasks: tasks.map((task) => ({
                run_id: task.run_id,
                title: task.title,
                bot_id: task.bot_id,
                status: task.status,
                summary: task.summary,
                created_at: task.created_at,
              })),
            };
          }
          case 'cancel': {
            if (!input.run_id) return { action: 'cancel', status: 'refused', reason: 'run_id is required (see list).' };
            const result = await cancelBotTask(ctx.db, ctx.userId, input.run_id, ctx.sessionId);
            if (result === 'not_found')
              return { action: 'cancel', status: 'refused', reason: 'No such task in this conversation.' };
            if (result === 'finished')
              return { action: 'cancel', status: 'refused', reason: 'That task has already finished.' };
            return { action: 'cancel', status: 'canceling', run_id: input.run_id };
          }
        }
      } catch (error) {
        return { action: input.action, error: toErrorMessage(error) };
      }
    },
  });
}
