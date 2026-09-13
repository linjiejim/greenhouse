/**
 * Automation Query tool — read side of Automations (the user's scheduled
 * tasks): list them, or inspect one with its recent execution sessions.
 *
 * Owner-scoped by construction (scope: 'own'), so a model never sees another
 * person's automation even when the caller is a super. Lazy: needs the
 * requesting user's identity, wired in buildLazyServerTools. Not session-scoped
 * — automations belong to a user, so the tool also works over proxy/MCP.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';
import { getTask, listTasks, type TaskActor } from '../scheduler/task-center.js';

const automationQuerySchema = z.object({
  action: z.enum(['list', 'get']).describe('list: all of my automations. get: one automation plus its recent runs.'),
  id: z.number().int().optional().describe('Automation id — required for get.'),
});

type AutomationQueryInput = z.infer<typeof automationQuerySchema>;

export interface AutomationToolContext {
  userId: string;
  userRole: string;
}

const meta: ToolMeta = {
  id: 'automation_query',
  name: 'Automation Query',
  brief: "Read the user's Automations (scheduled tasks): schedule, status, last/next run",
  description: `Read the current user's Automations — scheduled tasks that run an agent on a cron schedule (what the "Automation" screen shows). \`list\` returns every automation you own with its schedule, enabled flag, last_status and next_run_at; \`get\` adds recent_runs, the last executions with their session ids, so you can tell whether one actually fired and point the user at the resulting conversation. Read here before changing anything with automation_mutation. Only your own are visible. Unrelated to Tables automation rules, which fire on record changes.`,
  category: 'core',
  is_global: true,
  builtin: true,
  icon: 'Clock',
  surface: { proxy: 'read', mcp: 'automation', unattendedReplaySafe: true },
  sort_order: 36,
};

export function createAutomationQueryTool(db: DatabaseProvider, ctx: AutomationToolContext) {
  // scope 'own' — the role is carried for audit parity, never to widen access.
  const actor: TaskActor = { userId: ctx.userId, role: ctx.userRole, scope: 'own' };
  return tool({
    description: meta.description,
    inputSchema: automationQuerySchema,
    execute: async (input: AutomationQueryInput) => {
      try {
        if (input.action === 'list') {
          const result = await listTasks(db, actor);
          if (!result.ok) return { action: input.action, error: result.error };
          return { action: input.action, count: result.tasks.length, automations: result.tasks };
        }

        if (input.id === undefined) return { action: input.action, error: 'id is required for get' };
        const result = await getTask(db, actor, input.id);
        if (!result.ok) return { action: input.action, error: result.error };
        return { action: input.action, automation: result.task, recent_runs: result.recent_runs };
      } catch (error) {
        return { action: input.action, error: toErrorMessage(error) };
      }
    },
  });
}

export const automationQueryTool = defineTool({ meta, kind: 'lazy' });
