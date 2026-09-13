/**
 * Drizzle schema — User management tables (PostgreSQL).
 *
 * Tables: users, user_tools, refresh_tokens, account_password_links
 */

import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, integer, index, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';

// ─── users ────────────────────────────────────────────────

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  password_hash: text('password_hash').notNull(),
  auth_version: integer('auth_version').notNull().default(0),
  nickname: text('nickname').notNull(),
  role: text('role', { enum: ['super', 'team', 'external'] })
    .notNull()
    .default('team'),
  status: text('status', { enum: ['invited', 'active', 'reset_required', 'disabled'] })
    .notNull()
    .default('active'),
  daily_message_limit: integer('daily_message_limit').notNull().default(200),
  // 20M was set while nothing enforced it. Real internal usage runs ~1.5M/day
  // on active days, so it locked people out mid-month once the usage budget
  // started admitting calls against it. See migration 0062.
  monthly_token_limit: integer('monthly_token_limit').notNull().default(100000000),
  notes: text('notes'),
  locale: text('locale').notNull().default('en'),
  created_by: text('created_by'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  last_login_at: timestamp('last_login_at', { withTimezone: true, mode: 'string' }),
});

// ─── user_tools ───────────────────────────────────────────

export const userTools = pgTable(
  'user_tools',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tool_id: text('tool_id').notNull(),
    assigned_by: text('assigned_by'),
    assigned_at: timestamp('assigned_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.tool_id] })],
);

// ─── refresh_tokens ───────────────────────────────────────

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token_hash: text('token_hash').notNull(),
    auth_version: integer('auth_version').notNull().default(0),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_refresh_tokens_hash').on(table.token_hash),
    index('idx_refresh_tokens_user').on(table.user_id),
  ],
);

// ─── account_password_links ──────────────────────────────

export const accountPasswordLinks = pgTable(
  'account_password_links',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['invite', 'reset'] }).notNull(),
    /** SHA-256 of the 32-byte random bearer token. Plaintext is never persisted. */
    token_hash: text('token_hash').notNull(),
    issued_auth_version: integer('issued_auth_version').notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    consumed_at: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
    revoked_at: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    /** Loose user reference: creator deletion must not destroy account-security history. */
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    sent_at: timestamp('sent_at', { withTimezone: true, mode: 'string' }),
    delivery_status: text('delivery_status', { enum: ['pending', 'sent', 'failed'] })
      .notNull()
      .default('pending'),
    delivery_error: text('delivery_error'),
  },
  (table) => [
    uniqueIndex('uq_account_password_links_token_hash').on(table.token_hash),
    uniqueIndex('uq_account_password_links_current_user')
      .on(table.user_id)
      .where(sql`${table.consumed_at} IS NULL AND ${table.revoked_at} IS NULL`),
    index('idx_account_password_links_user_created').on(table.user_id, table.created_at),
    index('idx_account_password_links_expires').on(table.expires_at),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type UserRow = typeof users.$inferSelect;
export type UserRole = UserRow['role'];
export type UserStatus = UserRow['status'];
export type UserToolRow = typeof userTools.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type AccountPasswordLinkRow = typeof accountPasswordLinks.$inferSelect;
export type AccountPasswordLinkPurpose = AccountPasswordLinkRow['purpose'];
export type AccountPasswordLinkDeliveryStatus = AccountPasswordLinkRow['delivery_status'];
