/**
 * Automations and the agent configurations they (and chats) run as.
 *
 * Tables: automations, automation_occurrences, run_profiles
 */

import { boolean, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, oneOf, updatedAt } from './_columns.js';
import { users } from './identity.js';

/** Where an automation reports a finished run. `webhook` null = no webhook. */
export interface AutomationNotify {
  webhook: string | null;
  email: boolean;
  wecom: boolean;
  feishu: boolean;
}

export const DEFAULT_AUTOMATION_NOTIFY: AutomationNotify = { webhook: null, email: false, wecom: false, feishu: false };

export const automations = pgTable(
  'automations',
  {
    id: id(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    profile_id: text('profile_id').notNull().default('team'),
    task_prompt: text('task_prompt').notNull(),
    /** Cron expression, e.g. `0 22 * * *`. */
    schedule: text('schedule').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    enabled: boolean('enabled').notNull().default(true),
    max_steps: integer('max_steps').notNull().default(15),
    notify: json<AutomationNotify>('notify', DEFAULT_AUTOMATION_NOTIFY),
    quiet_when_empty: boolean('quiet_when_empty').notNull().default(false),
    /** Tool ids allowed to write without a person present. */
    unattended_tools: json<string[]>('unattended_tools', []),
    last_run_at: at('last_run_at'),
    /** completed / failed / canceled / interrupted / running / missed */
    last_status: text('last_status'),
    next_run_at: at('next_run_at'),
    run_count: integer('run_count').notNull().default(0),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    index('idx_automations_user').on(table.user_id),
    index('idx_automations_next_run').on(table.enabled, table.next_run_at),
  ],
);

export const OCCURRENCE_STATUSES = ['succeeded', 'failed', 'canceled', 'interrupted'] as const;

/**
 * Terminal outcomes of automation runs, projected once from the run outbox
 * (`runtime_run_id` is the idempotency key). Logical references only: the
 * history outlives the automation.
 */
export const automationOccurrences = pgTable(
  'automation_occurrences',
  {
    runtime_run_id: text('runtime_run_id').primaryKey(),
    task_id: text('task_id').notNull(),
    owner_user_id: text('owner_user_id').notNull(),
    status: text('status', { enum: OCCURRENCE_STATUSES }).notNull(),
    runtime_version: integer('runtime_version').notNull(),
    scheduled_for: at('scheduled_for').notNull(),
    run_created_at: at('run_created_at').notNull(),
    projected_at: at('projected_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_automation_occurrences_task').on(table.task_id, table.run_created_at),
    index('idx_automation_occurrences_owner').on(table.owner_user_id, table.projected_at),
    oneOf('chk_automation_occurrences_status', table.status, OCCURRENCE_STATUSES),
  ],
);

export const RUN_PROFILE_RISK_LEVELS = ['low', 'medium', 'high'] as const;

/**
 * A member's custom agent (`custom:<id>`): a base preset plus model, tools and
 * prompt. Private to its owner unless a super sets `is_shared`. `version`
 * counts configuration edits; 1.x pins (`custom:<id>@<n>`) resolve to the
 * current configuration — immutable versions were retired in 3.0.
 */
export const runProfiles = pgTable(
  'run_profiles',
  {
    id: id(),
    slug: text('slug').notNull(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    base_profile_id: text('base_profile_id').notNull().default('team'),
    model_id: text('model_id'),
    tools: json<string[]>('tools', []),
    system_prompt: text('system_prompt').notNull(),
    max_steps: integer('max_steps').notNull().default(12),
    is_shared: boolean('is_shared').notNull().default(false),
    avatar: json<Record<string, unknown>>('avatar', {}),
    purpose: text('purpose'),
    audience: text('audience'),
    risk_level: text('risk_level', { enum: RUN_PROFILE_RISK_LEVELS }).notNull().default('medium'),
    budget_policy: json<Record<string, unknown>>('budget_policy', {}),
    owner_backup_user_id: text('owner_backup_user_id').references(() => users.id, { onDelete: 'set null' }),
    version: integer('version').notNull().default(1),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    unique('uq_run_profiles_user_slug').on(table.user_id, table.slug),
    index('idx_run_profiles_shared').on(table.is_shared),
    index('idx_run_profiles_backup_owner').on(table.owner_backup_user_id),
    oneOf('chk_run_profiles_risk', table.risk_level, RUN_PROFILE_RISK_LEVELS),
  ],
);

export type ScheduledTaskRow = typeof automations.$inferSelect;
export type ScheduledTaskRuntimeOccurrenceRow = typeof automationOccurrences.$inferSelect;
export type CustomProfileRow = typeof runProfiles.$inferSelect;
export type CustomProfileRiskLevel = CustomProfileRow['risk_level'];
