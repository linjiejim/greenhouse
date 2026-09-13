/**
 * Drizzle schema — Scheduled Tasks table (PostgreSQL).
 *
 * Tables: scheduled_tasks
 *
 * Stores task definitions for automated Agent execution.
 * Each execution creates a new session (channel='task', metadata.task_id).
 */

import { pgTable, serial, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './user.js';

export const scheduledTasks = pgTable(
  'scheduled_tasks',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    profile_id: text('profile_id').notNull().default('team'),
    task_prompt: text('task_prompt').notNull(),
    schedule: text('schedule').notNull(), // cron expression, e.g. "0 22 * * *"
    timezone: text('timezone').notNull().default('UTC'),
    enabled: boolean('enabled').notNull().default(true),
    max_steps: integer('max_steps').notNull().default(15),
    // Optional WeCom (企业微信) group webhook. The scheduler — not the agent —
    // posts a run summary here when set, so delivery stays a system behaviour
    // rather than an outbound-call tool the model could aim anywhere.
    notify_webhook: text('notify_webhook'),
    // Deliver the same run summary by email to the OWNER's account address.
    // A boolean, not an address: the recipient is derived from the task owner so
    // this channel can never be aimed anywhere, matching notify_webhook's
    // "system decides where it goes" property.
    notify_email: boolean('notify_email').notNull().default(false),
    // Deliver the same run summary as a WeCom app message to the OWNER.
    // A boolean for the same reason as notify_email: `touser` is derived from
    // the owner's stored WeCom binding, so there is no recipient field for
    // anyone — model or user — to point somewhere else.
    notify_wecom: boolean('notify_wecom').notNull().default(false),
    // Deliver the same run summary as a Feishu card DM to the OWNER.
    // A boolean for the same reason as notify_wecom: the `open_id` is derived
    // from the owner's stored Feishu binding at send time.
    notify_feishu: boolean('notify_feishu').notNull().default(false),
    // Tools the OWNER explicitly granted to this automation's unattended runs,
    // beyond the fail-closed replay-safe read whitelist. JSON string array; the
    // catalog of legal ids is `@greenhouse/types/automation-tools`.
    //
    // This is a FILTER, never a grant: the runtime set is
    // `this ∩ catalog ∩ the owner's currently effective tools`, recomputed on
    // every execution. It is also writable only through the HTTP console (the
    // user's own Bearer) — `automation_mutation` refuses it, because the whole
    // premise is that a person ticked the box.
    unattended_tools: text('unattended_tools').notNull().default('[]'),
    last_run_at: timestamp('last_run_at', { withTimezone: true, mode: 'string' }),
    last_status: text('last_status'), // 'completed' | 'failed' | 'running'
    next_run_at: timestamp('next_run_at', { withTimezone: true, mode: 'string' }),
    run_count: integer('run_count').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_scheduled_tasks_user').on(table.user_id),
    index('idx_scheduled_tasks_enabled').on(table.enabled),
    index('idx_scheduled_tasks_next_run').on(table.next_run_at),
  ],
);

/**
 * Permanent, exactly-once projection ledger for terminal Automation Runtime
 * occurrences. Runtime and task ids are logical: the execution/accounting fact
 * must survive a later user or task deletion.
 */
export const scheduledTaskRuntimeOccurrences = pgTable(
  'scheduled_task_runtime_occurrences',
  {
    runtime_run_id: text('runtime_run_id').primaryKey(),
    task_id: integer('task_id').notNull(),
    owner_user_id: text('owner_user_id').notNull(),
    status: text('status', { enum: ['succeeded', 'failed', 'canceled'] }).notNull(),
    runtime_version: integer('runtime_version').notNull(),
    scheduled_for: timestamp('scheduled_for', { withTimezone: true, mode: 'string' }).notNull(),
    run_created_at: timestamp('run_created_at', { withTimezone: true, mode: 'string' }).notNull(),
    projected_at: timestamp('projected_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_scheduled_task_runtime_occurrences_task').on(table.task_id, table.run_created_at),
    index('idx_scheduled_task_runtime_occurrences_owner').on(table.owner_user_id, table.projected_at),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type ScheduledTaskRow = typeof scheduledTasks.$inferSelect;
export type ScheduledTaskRuntimeOccurrenceRow = typeof scheduledTaskRuntimeOccurrences.$inferSelect;
