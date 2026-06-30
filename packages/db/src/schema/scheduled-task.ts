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
    profile_id: text('profile_id').notNull().default('default'),
    task_prompt: text('task_prompt').notNull(),
    schedule: text('schedule').notNull(), // cron expression, e.g. "0 22 * * *"
    timezone: text('timezone').notNull().default('UTC'),
    enabled: boolean('enabled').notNull().default(true),
    max_steps: integer('max_steps').notNull().default(15),
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

// ─── Row types (inferred — schema is the single source of truth) ──

export type ScheduledTaskRow = typeof scheduledTasks.$inferSelect;
