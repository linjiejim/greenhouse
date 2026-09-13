/**
 * Drizzle schema — Platform OAuth 2.1 authorization server.
 *
 * Raw authorization codes and tokens are never persisted. Only SHA-256 hashes
 * are stored, so a database read alone cannot be used to call the MCP server.
 */

import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { users } from './user.js';

export const platformOAuthClients = pgTable(
  'platform_oauth_clients',
  {
    id: text('id').primaryKey(),
    client_name: text('client_name').notNull(),
    redirect_uris: text('redirect_uris').notNull().default('[]'),
    // 'none' = public client (interactive authorization-code + PKCE, via DCR).
    // 'client_secret_post' = machine client (client_credentials, admin-created
    // only): client_secret_hash + bound_user_id are then required, and
    // allowed_scopes caps what its tokens may carry.
    token_endpoint_auth_method: text('token_endpoint_auth_method', { enum: ['none', 'client_secret_post'] })
      .notNull()
      .default('none'),
    client_secret_hash: text('client_secret_hash'),
    bound_user_id: text('bound_user_id').references(() => users.id, { onDelete: 'cascade' }),
    allowed_scopes: text('allowed_scopes').notNull().default('[]'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    created_by: text('created_by'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_platform_oauth_clients_status').on(table.status, table.created_at)],
);

export const platformOAuthGrants = pgTable(
  'platform_oauth_grants',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    client_id: text('client_id')
      .notNull()
      .references(() => platformOAuthClients.id, { onDelete: 'cascade' }),
    resource: text('resource').notNull(),
    scopes: text('scopes').notNull().default('[]'),
    status: text('status', { enum: ['active', 'revoked'] })
      .notNull()
      .default('active'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    revoked_at: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('uq_platform_oauth_grants_principal').on(table.user_id, table.client_id, table.resource),
    index('idx_platform_oauth_grants_user_status').on(table.user_id, table.status, table.updated_at),
    index('idx_platform_oauth_grants_client').on(table.client_id, table.status),
  ],
);

export const platformOAuthAuthorizationCodes = pgTable(
  'platform_oauth_authorization_codes',
  {
    code_hash: text('code_hash').primaryKey(),
    grant_id: text('grant_id')
      .notNull()
      .references(() => platformOAuthGrants.id, { onDelete: 'cascade' }),
    client_id: text('client_id')
      .notNull()
      .references(() => platformOAuthClients.id, { onDelete: 'cascade' }),
    redirect_uri: text('redirect_uri').notNull(),
    resource: text('resource').notNull(),
    scopes: text('scopes').notNull().default('[]'),
    code_challenge: text('code_challenge').notNull(),
    code_challenge_method: text('code_challenge_method', { enum: ['S256'] })
      .notNull()
      .default('S256'),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    used_at: timestamp('used_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_platform_oauth_codes_grant').on(table.grant_id),
    index('idx_platform_oauth_codes_expiry').on(table.expires_at),
  ],
);

export const platformOAuthTokens = pgTable(
  'platform_oauth_tokens',
  {
    id: text('id').primaryKey(),
    grant_id: text('grant_id')
      .notNull()
      .references(() => platformOAuthGrants.id, { onDelete: 'cascade' }),
    token_hash: text('token_hash').notNull(),
    token_type: text('token_type', { enum: ['access', 'refresh'] }).notNull(),
    resource: text('resource').notNull(),
    scopes: text('scopes').notNull().default('[]'),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    revoked_at: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    last_used_at: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_platform_oauth_tokens_hash').on(table.token_hash),
    index('idx_platform_oauth_tokens_grant_type').on(table.grant_id, table.token_type),
    index('idx_platform_oauth_tokens_expiry').on(table.expires_at),
  ],
);

export type PlatformOAuthClientRow = typeof platformOAuthClients.$inferSelect;
export type PlatformOAuthClientStatus = PlatformOAuthClientRow['status'];
export type PlatformOAuthGrantRow = typeof platformOAuthGrants.$inferSelect;
export type PlatformOAuthAuthorizationCodeRow = typeof platformOAuthAuthorizationCodes.$inferSelect;
export type PlatformOAuthTokenRow = typeof platformOAuthTokens.$inferSelect;
