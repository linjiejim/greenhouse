/**
 * Notification center, external deliveries and mobile push devices.
 *
 * Tables: notifications, notification_deliveries, push_devices
 *
 * `notifications` is the permanent in-app fact, idempotent per (user, dedupe_key);
 * only `read_at` changes. Deliveries are the transport queue (WeCom / Feishu /
 * email / mobile push) with lease + retry; terminal ones are kept 7 days
 * (`retention.ts`). Users, runs, interrupts, events and agents are logical
 * references.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, oneOf, updatedAt } from './_columns.js';
import { users } from './identity.js';

export const NOTIFICATION_KINDS = [
  'runtime_attention',
  'runtime_completed',
  'runtime_failed',
  'agent_review_due',
  'agent_suspended',
  'budget_attention',
  'system',
] as const;

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    user_id: text('user_id').notNull(),
    kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: json<Record<string, unknown>>('payload', {}),
    run_id: text('run_id'),
    interrupt_id: text('interrupt_id'),
    event_id: text('event_id'),
    agent_id: text('agent_id'),
    dedupe_key: text('dedupe_key').notNull(),
    read_at: at('read_at'),
    created_at: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_notifications_user_dedupe').on(table.user_id, table.dedupe_key),
    index('idx_notifications_user_unread_created').on(table.user_id, table.read_at, table.created_at),
    index('idx_notifications_run').on(table.run_id),
    index('idx_notifications_interrupt').on(table.interrupt_id),
    index('idx_notifications_event').on(table.event_id),
    index('idx_notifications_agent').on(table.agent_id),
    oneOf('chk_notifications_kind', table.kind, NOTIFICATION_KINDS),
  ],
);

export const DELIVERY_CHANNELS = ['desktop', 'wecom', 'feishu', 'email', 'mobile_push'] as const;
export const DELIVERY_STATUSES = ['pending', 'claimed', 'delivered', 'failed', 'dead_letter', 'suppressed'] as const;

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: id(),
    notification_id: text('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: DELIVERY_CHANNELS }).notNull(),
    recipient: text('recipient').notNull(),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    max_attempts: integer('max_attempts').notNull().default(5),
    available_at: at('available_at').notNull(),
    lease_owner: text('lease_owner'),
    lease_expires_at: at('lease_expires_at'),
    last_error: text('last_error'),
    delivered_at: at('delivered_at'),
    created_at: createdAt(),
    updated_at: updatedAt(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    uniqueIndex('uq_notification_deliveries_channel_recipient').on(
      table.notification_id,
      table.channel,
      table.recipient,
    ),
    index('idx_notification_deliveries_claim').on(table.status, table.available_at, table.lease_expires_at),
    index('idx_notification_deliveries_updated').on(table.status, table.updated_at),
    oneOf('chk_notification_deliveries_channel', table.channel, DELIVERY_CHANNELS),
    oneOf('chk_notification_deliveries_status', table.status, DELIVERY_STATUSES),
    check(
      'chk_notification_deliveries_attempts',
      sql`${table.attempts} >= 0 AND ${table.max_attempts} > 0 AND ${table.version} > 0`,
    ),
  ],
);

export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export const PUSH_DISABLED_REASONS = ['unregistered', 'device_not_registered', 'device_limit'] as const;

export const pushDevices = pgTable(
  'push_devices',
  {
    id: id(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    platform: text('platform', { enum: PUSH_PLATFORMS }).notNull(),
    project_id: text('project_id').notNull(),
    client_ref: text('client_ref'),
    prefs: json<Record<string, unknown>>('prefs', {}),
    auth_version: integer('auth_version').notNull(),
    created_at: createdAt(),
    last_seen_at: at('last_seen_at').notNull().defaultNow(),
    disabled_at: at('disabled_at'),
    disabled_reason: text('disabled_reason', { enum: PUSH_DISABLED_REASONS }),
  },
  (table) => [
    uniqueIndex('uq_push_devices_token').on(table.token),
    index('idx_push_devices_user_active')
      .on(table.user_id)
      .where(sql`${table.disabled_at} IS NULL`),
    oneOf('chk_push_devices_platform', table.platform, PUSH_PLATFORMS),
    oneOf('chk_push_devices_disabled_reason', table.disabled_reason, PUSH_DISABLED_REASONS),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationKind = NotificationRow['kind'];
export type NotificationDeliveryAttemptRow = typeof notificationDeliveries.$inferSelect;
export type NotificationDeliveryChannel = NotificationDeliveryAttemptRow['channel'];
export type NotificationDeliveryStatus = NotificationDeliveryAttemptRow['status'];
export type PushDeviceRow = typeof pushDevices.$inferSelect;
export type PushDevicePlatform = PushDeviceRow['platform'];
export type PushDeviceDisabledReason = NonNullable<PushDeviceRow['disabled_reason']>;
