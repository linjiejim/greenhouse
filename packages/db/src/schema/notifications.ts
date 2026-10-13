import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, updatedAt } from './_columns.js';
import { agents } from './agents.js';
import { members } from './identity.js';

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

export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export const PUSH_DISABLED_REASONS = ['unregistered', 'device_not_registered', 'device_limit'] as const;
export type PushDisabledReason = (typeof PUSH_DISABLED_REASONS)[number];

/** A phone's own switches. They only narrow what the member's settings allow on that phone. */
export type PushPrefs = {
  needs_you: boolean;
  /** Runs and schedules that finished. */
  done: boolean;
  replies: boolean;
  preview: boolean;
  /** The phone shows background runs as Live Activities: a run's end also wakes the app. */
  live_activity: boolean;
};

/**
 * Phones that receive this deployment's pushes: an Expo push token, never an Apple key.
 * Registering a token again refreshes its row; under another member the row moves there with
 * fresh prefs. Rows are never deleted: unregistering and Expo's DeviceNotRegistered only disable
 * them. `authVersion` is the member's at registration, so a password change or a disable stops
 * pushes until the phone registers again.
 */
export const pushDevices = pgTable(
  'push_devices',
  {
    id: id(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    platform: text('platform', { enum: PUSH_PLATFORMS }).notNull(),
    /** The Expo project the token belongs to; messages go out per project. */
    projectId: text('project_id').notNull(),
    /** The phone's own id for this workspace, echoed in every push. */
    clientRef: text('client_ref'),
    prefs: json<Partial<PushPrefs>>('prefs', {}),
    authVersion: integer('auth_version').notNull(),
    lastSeenAt: at('last_seen_at').notNull().defaultNow(),
    disabledAt: at('disabled_at'),
    disabledReason: text('disabled_reason', { enum: PUSH_DISABLED_REASONS }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('push_devices_token_key').on(t.token),
    index('push_devices_member_active_idx')
      .on(t.memberId)
      .where(sql`${t.disabledAt} IS NULL`),
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
export type PushDeviceRow = typeof pushDevices.$inferSelect;
export type ScheduleRow = typeof schedules.$inferSelect;
