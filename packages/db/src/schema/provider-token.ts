/**
 * Drizzle schema — Provider token storage (PostgreSQL).
 *
 * Tables: user_provider_tokens
 *
 * Generic storage for OAuth/exchange tokens from connected providers.
 * Supports per-workspace bindings (an upstream API with several environments) and
 * workspace-independent providers (workspace_id = NULL).
 */

import { pgTable, serial, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { users } from './user.js';

// ─── user_provider_tokens ─────────────────────────────────

export const userProviderTokens = pgTable(
  'user_provider_tokens',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // e.g. 'feishu' | 'wecom'
    workspace_id: text('workspace_id'), // upstream environment id; NULL when workspace-independent
    /**
     * AES-256-GCM encrypted access token, when the provider issues per-user
     * ones. NULL for providers where the binding is an IDENTITY rather than a
     * credential: WeCom's app token is corp-global and cached in-process, so a
     * per-user row there has nothing to hold. Storing an empty string instead
     * would make the column's own contract untrue.
     */
    access_token: text('access_token'),
    refresh_token: text('refresh_token'), // AES-256-GCM encrypted
    provider_credential: text('provider_credential'), // AES-256-GCM encrypted (e.g. password for auto re-login)
    token_type: text('token_type').notNull().default('Bearer'),
    scope: text('scope'), // space-separated or JSON array
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    provider_user_id: text('provider_user_id'), // user ID on provider side
    provider_email: text('provider_email'), // email on provider side (display)
    provider_name: text('provider_name'), // display name on provider side
    metadata: text('metadata').notNull().default('{}'), // JSON: roles, permissions, etc.
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    unique('uq_user_provider_workspace').on(table.user_id, table.provider, table.workspace_id).nullsNotDistinct(),
    index('idx_provider_tokens_user').on(table.user_id),
    index('idx_provider_tokens_provider').on(table.user_id, table.provider),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type ProviderTokenRow = typeof userProviderTokens.$inferSelect;
