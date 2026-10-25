/**
 * Identity: accounts and the short-lived state around signing in.
 *
 * Tables: users, auth_refresh_tokens, password_links, login_states, rate_limits
 */

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import type { UserPreferences } from '@greenhouse/types/preferences';
import { at, createdAt, id, json, oneOf, updatedAt } from './_columns.js';

export const USER_ROLES = ['super', 'team', 'external'] as const;
export const USER_STATUSES = ['invited', 'active', 'reset_required', 'disabled'] as const;

// ─── users ────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    password_hash: text('password_hash').notNull(),
    /** Credential generation: bumped by password resets and disabling; tokens and push devices compare it. */
    auth_version: integer('auth_version').notNull().default(0),
    nickname: text('nickname').notNull(),
    /** `external` only survives on carried, disabled rows; auth rejects it. */
    role: text('role', { enum: USER_ROLES }).notNull().default('team'),
    status: text('status', { enum: USER_STATUSES }).notNull().default('active'),
    notes: text('notes'),
    locale: text('locale').notNull().default('en'),
    /** Member preferences that follow the account (font scale). */
    preferences: json<UserPreferences>('preferences', {}),
    created_by: text('created_by'),
    created_at: createdAt(),
    updated_at: updatedAt(),
    last_login_at: at('last_login_at'),
  },
  (table) => [
    uniqueIndex('uq_users_email').on(table.email),
    oneOf('chk_users_role', table.role, USER_ROLES),
    oneOf('chk_users_status', table.status, USER_STATUSES),
  ],
);

// ─── auth_refresh_tokens ──────────────────────────────────

export const authRefreshTokens = pgTable(
  'auth_refresh_tokens',
  {
    id: id(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token_hash: text('token_hash').notNull(),
    auth_version: integer('auth_version').notNull().default(0),
    expires_at: at('expires_at').notNull(),
    created_at: createdAt(),
  },
  (table) => [
    index('idx_auth_refresh_tokens_hash').on(table.token_hash),
    index('idx_auth_refresh_tokens_user').on(table.user_id),
    index('idx_auth_refresh_tokens_expires').on(table.expires_at),
  ],
);

// ─── password_links ───────────────────────────────────────

export const PASSWORD_LINK_PURPOSES = ['invite', 'reset'] as const;
export const PASSWORD_LINK_DELIVERY = ['pending', 'sent', 'failed'] as const;

export const passwordLinks = pgTable(
  'password_links',
  {
    id: id(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: PASSWORD_LINK_PURPOSES }).notNull(),
    /** SHA-256 of the 32-byte random bearer token. Plaintext is never persisted. */
    token_hash: text('token_hash').notNull(),
    issued_auth_version: integer('issued_auth_version').notNull(),
    expires_at: at('expires_at').notNull(),
    consumed_at: at('consumed_at'),
    revoked_at: at('revoked_at'),
    /** Loose user reference: creator deletion must not destroy account-security history. */
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
    sent_at: at('sent_at'),
    delivery_status: text('delivery_status', { enum: PASSWORD_LINK_DELIVERY }).notNull().default('pending'),
    delivery_error: text('delivery_error'),
  },
  (table) => [
    uniqueIndex('uq_password_links_token_hash').on(table.token_hash),
    uniqueIndex('uq_password_links_current_user')
      .on(table.user_id)
      .where(sql`${table.consumed_at} IS NULL AND ${table.revoked_at} IS NULL`),
    index('idx_password_links_user_created').on(table.user_id, table.created_at),
    index('idx_password_links_expires').on(table.expires_at),
    oneOf('chk_password_links_purpose', table.purpose, PASSWORD_LINK_PURPOSES),
    oneOf('chk_password_links_delivery', table.delivery_status, PASSWORD_LINK_DELIVERY),
  ],
);

// ─── login_states ─────────────────────────────────────────

export const LOGIN_STATE_KINDS = ['pending', 'login_code'] as const;

/**
 * Feishu / WeCom login `state` values and one-time login codes. `id` is the
 * SHA-256 of the value; the raw value never touches the DB.
 */
export const loginStates = pgTable(
  'login_states',
  {
    id: id(),
    provider: text('provider').notNull(),
    kind: text('kind', { enum: LOGIN_STATE_KINDS }).notNull(),
    payload: json<Record<string, unknown>>('payload', {}),
    expires_at: at('expires_at').notNull(),
    consumed_at: at('consumed_at'),
    created_at: createdAt(),
  },
  (table) => [
    index('idx_login_states_expires').on(table.expires_at),
    oneOf('chk_login_states_kind', table.kind, LOGIN_STATE_KINDS),
  ],
);

// ─── rate_limits ──────────────────────────────────────────

/** Fixed-window counters; `key` is `<rule>:<subject>:<window start ms>`. Swept once expired. */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull().default(0),
    expires_at: at('expires_at').notNull(),
  },
  (table) => [index('idx_rate_limits_expires').on(table.expires_at)],
);

// ─── Row types ────────────────────────────────────────────

export type UserRow = typeof users.$inferSelect;
export type UserRole = UserRow['role'];
export type UserStatus = UserRow['status'];
export type RefreshTokenRow = typeof authRefreshTokens.$inferSelect;
export type AccountPasswordLinkRow = typeof passwordLinks.$inferSelect;
export type AccountPasswordLinkPurpose = AccountPasswordLinkRow['purpose'];
export type AccountPasswordLinkDeliveryStatus = AccountPasswordLinkRow['delivery_status'];
export type OAuthLoginStateRow = typeof loginStates.$inferSelect;
export type RateLimitBucketRow = typeof rateLimits.$inferSelect;
