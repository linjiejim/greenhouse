/**
 * Drizzle schema — platform notification center (PostgreSQL).
 *
 * `notifications` is the permanent in-app fact. Delivery attempts are a
 * separate transport ledger so a failed optional channel can never rewrite a
 * successful Runtime/Agent business outcome. User/Run/Interrupt/Event ids are
 * logical references on purpose: CEO/CTO policy requires notification and
 * execution history to survive source-account/domain deletion.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull(),
    kind: text('kind', {
      enum: [
        'runtime_attention',
        'runtime_completed',
        'runtime_failed',
        'agent_review_due',
        'agent_suspended',
        'budget_attention',
        'system',
      ],
    }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: text('payload').notNull().default('{}'),
    /** Logical provenance links; the notification remains after source deletion. */
    run_id: text('run_id'),
    interrupt_id: text('interrupt_id'),
    event_id: text('event_id'),
    agent_id: text('agent_id'),
    dedupe_key: text('dedupe_key').notNull(),
    read_at: timestamp('read_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_notifications_user_dedupe').on(table.user_id, table.dedupe_key),
    index('idx_notifications_user_unread_created').on(table.user_id, table.read_at, table.created_at),
    index('idx_notifications_run').on(table.run_id),
    index('idx_notifications_interrupt').on(table.interrupt_id),
    index('idx_notifications_event').on(table.event_id),
    index('idx_notifications_agent').on(table.agent_id),
  ],
);

export const notificationDeliveryAttempts = pgTable(
  'notification_delivery_attempts',
  {
    id: text('id').primaryKey(),
    notification_id: text('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['desktop', 'wecom', 'feishu', 'email', 'mobile_push'] }).notNull(),
    recipient: text('recipient').notNull(),
    status: text('status', { enum: ['pending', 'claimed', 'delivered', 'failed', 'dead_letter'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    max_attempts: integer('max_attempts').notNull().default(5),
    available_at: timestamp('available_at', { withTimezone: true, mode: 'string' }).notNull(),
    lease_owner: text('lease_owner'),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true, mode: 'string' }),
    last_error: text('last_error'),
    delivered_at: timestamp('delivered_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('uq_notification_delivery_channel_recipient').on(table.notification_id, table.channel, table.recipient),
    index('idx_notification_delivery_claim').on(table.status, table.available_at, table.lease_expires_at),
    check(
      'chk_notification_delivery_attempts',
      sql`${table.attempts} >= 0 AND ${table.max_attempts} > 0 AND ${table.version} > 0`,
    ),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationKind = NotificationRow['kind'];
export type NotificationDeliveryAttemptRow = typeof notificationDeliveryAttempts.$inferSelect;
export type NotificationDeliveryChannel = NotificationDeliveryAttemptRow['channel'];
export type NotificationDeliveryStatus = NotificationDeliveryAttemptRow['status'];
