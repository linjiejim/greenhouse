/**
 * Drizzle schema — shared security state (PostgreSQL).
 *
 * Tables: rate_limit_buckets, oauth_login_states
 *
 * State that used to live in one process's memory, so a restart or a second
 * instance reset it: fixed-window rate-limit counters, and the short-lived
 * Feishu / WeCom login `state` values and one-time login codes. Both are
 * swept once expired.
 */

import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    /** `<rule>:<subject>:<window start ms>` */
    key: text('key').primaryKey(),
    count: integer('count').notNull().default(0),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_rate_limit_buckets_expires').on(table.expires_at)],
);

export const OAUTH_LOGIN_STATE_KINDS = ['pending', 'login_code'] as const;

export const oauthLoginStates = pgTable(
  'oauth_login_states',
  {
    /** SHA-256 of the state / code value; the raw value never touches the DB. */
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    kind: text('kind', { enum: OAUTH_LOGIN_STATE_KINDS }).notNull(),
    payload: text('payload').notNull().default('{}'),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    consumed_at: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_oauth_login_states_expires').on(table.expires_at)],
);

export type RateLimitBucketRow = typeof rateLimitBuckets.$inferSelect;
export type OAuthLoginStateRow = typeof oauthLoginStates.$inferSelect;
