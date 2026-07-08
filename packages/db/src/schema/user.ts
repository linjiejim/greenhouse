/**
 * Drizzle schema — User management tables (PostgreSQL).
 *
 * Tables: users, user_profiles, user_tools, refresh_tokens, user_identities
 */

import { pgTable, text, timestamp, integer, index, primaryKey, unique } from 'drizzle-orm/pg-core';

// ─── users ────────────────────────────────────────────────

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  password_hash: text('password_hash').notNull(),
  nickname: text('nickname').notNull(),
  role: text('role', { enum: ['super', 'team', 'external'] })
    .notNull()
    .default('team'),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  daily_message_limit: integer('daily_message_limit').notNull().default(200),
  monthly_token_limit: integer('monthly_token_limit').notNull().default(20000000),
  notes: text('notes'),
  locale: text('locale').notNull().default('en'),
  created_by: text('created_by'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  last_login_at: timestamp('last_login_at', { withTimezone: true, mode: 'string' }),
});

// ─── user_profiles ────────────────────────────────────────

export const userProfiles = pgTable(
  'user_profiles',
  {
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profile_id: text('profile_id').notNull(),
    assigned_by: text('assigned_by'),
    assigned_at: timestamp('assigned_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.profile_id] })],
);

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
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_refresh_tokens_hash').on(table.token_hash),
    index('idx_refresh_tokens_user').on(table.user_id),
  ],
);

// ─── user_identities ──────────────────────────────────────
// External SSO identities bound to internal accounts (WeCom / Feishu / fork
// connectors). One row per (provider, subject); a user binds at most one
// identity per provider. See docs/specs/20260708-sso-identity-connectors.md.

export const userIdentities = pgTable(
  'user_identities',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    display_name: text('display_name'),
    avatar_url: text('avatar_url'),
    raw_profile: text('raw_profile'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    last_login_at: timestamp('last_login_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    unique('uq_user_identities_provider_subject').on(table.provider, table.subject),
    unique('uq_user_identities_user_provider').on(table.user_id, table.provider),
    index('idx_user_identities_user').on(table.user_id),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type UserRow = typeof users.$inferSelect;
export type UserRole = UserRow['role'];
export type UserStatus = UserRow['status'];
export type UserProfileRow = typeof userProfiles.$inferSelect;
export type UserToolRow = typeof userTools.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type UserIdentityRow = typeof userIdentities.$inferSelect;
