import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, updatedAt } from './_columns.js';
import { agents } from './agents.js';

export const NOTIFICATION_KINDS = [
  'request',
  'run_done',
  'run_failed',
  'reply',
  'mention',
  'comment',
  'share',
  'automation',
  'skill_scan',
  'budget',
  'system',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** In-app notifications are permanent and idempotent; only the read state changes. */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    memberId: text('member_id').notNull(),
    kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    targetType: text('target_type'),
    targetId: text('target_id'),
    requestId: text('request_id'),
    runId: text('run_id'),
    agentId: text('agent_id'),
    /** Routing for push and channels; never message content. */
    payload: json<Record<string, unknown>>('payload', {}),
    dedupeKey: text('dedupe_key').notNull(),
    readAt: at('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('notifications_dedupe_key').on(t.memberId, t.dedupeKey),
    index('notifications_member_idx').on(t.memberId, t.createdAt),
  ],
);

/** Schedules belong to an Agent; each firing starts a background run. */
export const schedules = pgTable(
  'schedules',
  {
    id: id(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id').notNull(),
    name: text('name').notNull(),
    brief: text('brief').notNull(),
    skillId: text('skill_id'),
    model: text('model'),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    status: text('status', { enum: ['active', 'paused'] })
      .notNull()
      .default('active'),
    nextRunAt: at('next_run_at'),
    lastRunAt: at('last_run_at'),
    lastRunId: text('last_run_id'),
    lastStatus: text('last_status'),
    runCount: integer('run_count').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('schedules_due_idx').on(t.status, t.nextRunAt), index('schedules_agent_idx').on(t.agentId)],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
