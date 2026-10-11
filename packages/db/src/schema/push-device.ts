/**
 * Drizzle schema — mobile push devices (PostgreSQL).
 *
 * One row per phone install that may receive this deployment's pushes
 * (docs/specs/20261010-mobile-push.md §3.2). The row holds the install's Expo
 * push token — never an Apple key: the deployment hands messages to the Expo
 * Push Service, which owns the APNs credentials of the official app.
 *
 * - `token` is unique: the same phone signing in as someone else re-assigns the
 *   row to the new account (and resets its prefs), so the previous account's
 *   events stop reaching that phone.
 * - `auth_version` is the account's credential generation at registration: a
 *   password reset or suspension bumps `users.auth_version`, and a device
 *   registered before it gets nothing until the member signs in again.
 * - `last_seen_at` is refreshed whenever the app comes to the foreground; a row
 *   not refreshed for 90 days is no longer delivered to.
 * - Unregistering (sign-out, removing the station, switching pushes off on the
 *   phone) and Expo's `DeviceNotRegistered` only disable the row
 *   (`disabled_at`); registering the token again re-enables it.
 * - `client_ref` is the device's own id for this station; every push carries it
 *   back so a tap from another station can switch there first.
 */

import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './user.js';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const pushDevices = pgTable(
  'push_devices',
  {
    /** `pdv_<hex>` — system-assigned. */
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `ExponentPushToken[…]`. */
    token: text('token').notNull(),
    platform: text('platform', { enum: ['ios'] }).notNull(),
    /** The Expo project the token belongs to (the official app's, or a fork's own). Messages are sent per project. */
    project_id: text('project_id').notNull(),
    /** The device's id for this station, echoed in every push (`data.s`). */
    client_ref: text('client_ref'),
    /** JSON `PushPrefs` (`@greenhouse/types/push`): needs_you / done / replies / preview. */
    prefs: text('prefs').notNull().default('{}'),
    /** `users.auth_version` at registration — a later password reset or suspension stops delivery. */
    auth_version: integer('auth_version').notNull(),
    created_at: ts('created_at').notNull(),
    last_seen_at: ts('last_seen_at').notNull(),
    disabled_at: ts('disabled_at'),
    /** `unregistered` (the member) · `device_not_registered` (Expo) · `device_limit` (too many active devices). */
    disabled_reason: text('disabled_reason', {
      enum: ['unregistered', 'device_not_registered', 'device_limit'],
    }),
  },
  (table) => [
    uniqueIndex('uq_push_devices_token').on(table.token),
    index('idx_push_devices_user_active')
      .on(table.user_id)
      .where(sql`${table.disabled_at} IS NULL`),
  ],
);

export type PushDeviceRow = typeof pushDevices.$inferSelect;
export type PushDeviceDisabledReason = NonNullable<PushDeviceRow['disabled_reason']>;
