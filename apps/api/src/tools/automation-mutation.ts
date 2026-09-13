/**
 * Automation Mutation tool — write side of Automations (the user's scheduled
 * tasks): create, update (including enable/disable), delete, and run now.
 *
 * Owner-scoped by construction (scope: 'own'). Validation, the per-user quota,
 * the hidden-profile gate and the scheduler coupling all live in
 * scheduler/task-center.ts, shared with the HTTP routes. Reachable over the
 * cloud proxy mutating allowlist (confirm:true per call) and MCP.
 *
 * Denied in unattended contexts (scheduled runs, workflow nodes): nobody is
 * there to confirm, and an automation that can create automations multiplies.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider } from '@greenhouse/db';
import { defineTool, type ToolMeta } from './define.js';
import { createTask, deleteTask, runTaskNow, updateTask, type TaskActor } from '../scheduler/task-center.js';
// Limits come from the LEAF module, never from task-center: this file sits on the
// registry ↔ scheduler import cycle and reads them while its own module body runs.
// Importing them from task-center puts them in the TDZ and the API dies at boot.
import { MAX_PROMPT_LENGTH, MAX_STEPS_LIMIT, MAX_TASKS_PER_USER, MIN_PROMPT_LENGTH } from '../scheduler/task-limits.js';
import type { AutomationToolContext } from './automation-query.js';

const automationMutationSchema = z.object({
  action: z
    .enum(['create', 'update', 'delete', 'run_now'])
    .describe('Write action. update also enables/disables via the enabled flag.'),
  id: z.number().int().optional().describe('Automation id — required for update, delete and run_now.'),
  name: z.string().optional().describe('Short display name, 2-50 characters.'),
  task_prompt: z
    .string()
    .optional()
    .describe(
      `What the agent should do on every run, written as a standalone instruction (the run has no chat history). ${MIN_PROMPT_LENGTH}-${MAX_PROMPT_LENGTH} characters.`,
    ),
  schedule: z
    .string()
    .optional()
    .describe('Standard 5-field cron expression, e.g. "0 9 * * 1-5" for 09:00 on weekdays. Minimum interval 1 hour.'),
  timezone: z.string().optional().describe('IANA timezone the cron is interpreted in. Defaults to UTC.'),
  profile_id: z.string().optional().describe('Agent profile the run uses. Defaults to the standard internal agent.'),
  max_steps: z.number().int().optional().describe(`Tool-call budget per run, 1-${MAX_STEPS_LIMIT}. Defaults to 15.`),
  enabled: z.boolean().optional().describe('false pauses the automation without deleting it.'),
  notify_webhook: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Group-bot webhook the scheduler posts each run summary to; must be an https://qyapi.weixin.qq.com (WeCom) or https://open.feishu.cn/open-apis/bot/... (Feishu) URL. null clears it. Without one the result only lands silently in the conversation list.',
    ),
  notify_email: z
    .boolean()
    .optional()
    .describe(
      "Email each run summary to the owner's own account address. No address to supply — it is always the owner.",
    ),
});

type AutomationMutationInput = z.infer<typeof automationMutationSchema>;

const meta: ToolMeta = {
  id: 'automation_mutation',
  name: 'Automation Mutation',
  brief: "Create and manage the user's Automations (scheduled agent tasks) with confirmation",
  description: `Manage the current user's Automations — scheduled tasks that run an agent on a cron schedule and deliver the result as a new conversation.

Each run starts a FRESH conversation with no history, so task_prompt must stand alone: "summarize yesterday's CRM follow-ups and flag the ones that slipped" works, "do that again" does not. Current date/time is injected automatically.

enabled:false pauses and enabled:true resumes — never delete what the user only wants paused. delete drops the definition but keeps past run conversations. run_now executes once immediately and returns its session_id, so the user can check the output without waiting for the schedule.

Always set notify_webhook or notify_email — a 03:00 run nobody is told about is worth little.

Before create, update or delete, state the configuration back in plain language — name, what it will do, and when it fires spelled out ("every weekday at 09:00 Hong Kong time") — then get explicit agreement. Read the current settings with automation_query first when changing an existing one.

Runs are unattended and get read-only tools. To write (tables, CRM, knowledge, projects) or make images, tell the user to tick it in Settings → Automations → edit → Tools; you cannot grant it.

Limit ${MAX_TASKS_PER_USER} per user; check the count with automation_query when near it. You can only manage your own. Unrelated to Tables automation rules, which fire on record changes.`,
  category: 'core',
  is_global: true,
  builtin: true,
  icon: 'AlarmClock',
  surface: { proxy: 'write' },
  sort_order: 37,
};

export function createAutomationMutationTool(db: DatabaseProvider, ctx: AutomationToolContext) {
  // scope 'own' — the role is carried for audit parity, never to widen access.
  // canGrantTools off: a model can draft an automation, never
  // grant it an unattended write tool (task-center.validateUnattendedTools).
  const actor: TaskActor = { userId: ctx.userId, role: ctx.userRole, scope: 'own', canGrantTools: false };
  return tool({
    description: meta.description,
    inputSchema: automationMutationSchema,
    execute: async (input: AutomationMutationInput) => {
      try {
        if (input.action === 'create') {
          const result = await createTask(db, actor, {
            name: input.name,
            task_prompt: input.task_prompt,
            schedule: input.schedule,
            timezone: input.timezone,
            profile_id: input.profile_id,
            max_steps: input.max_steps,
            enabled: input.enabled,
            notify_webhook: input.notify_webhook,
            notify_email: input.notify_email,
          });
          if (!result.ok) return { action: input.action, error: result.error };
          return { action: input.action, status: 'created', automation: result.task };
        }

        if (input.id === undefined) return { action: input.action, error: `id is required for ${input.action}` };

        if (input.action === 'update') {
          const result = await updateTask(db, actor, input.id, {
            name: input.name,
            task_prompt: input.task_prompt,
            schedule: input.schedule,
            timezone: input.timezone,
            profile_id: input.profile_id,
            max_steps: input.max_steps,
            enabled: input.enabled,
            notify_webhook: input.notify_webhook,
            notify_email: input.notify_email,
          });
          if (!result.ok) return { action: input.action, error: result.error };
          return { action: input.action, status: 'updated', automation: result.task };
        }

        if (input.action === 'delete') {
          const result = await deleteTask(db, actor, input.id);
          if (!result.ok) return { action: input.action, error: result.error };
          return { action: input.action, status: 'deleted', id: input.id, name: result.name };
        }

        // run_now — returns immediately; the agent keeps running in the background.
        const result = await runTaskNow(db, actor, input.id);
        if (!result.ok) return { action: input.action, error: result.error };
        return {
          action: input.action,
          status: 'started',
          id: input.id,
          name: result.name,
          session_id: result.session_id,
        };
      } catch (error) {
        return { action: input.action, error: toErrorMessage(error) };
      }
    },
  });
}

export const automationMutationTool = defineTool({ meta, kind: 'lazy' });
