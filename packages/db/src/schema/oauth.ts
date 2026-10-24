/**
 * External agents: OAuth 2.1 for MCP / the agent proxy, model-gateway keys and
 * members' connections to third-party providers.
 *
 * Tables: oauth_clients, oauth_grants, oauth_codes, oauth_tokens, gateway_keys,
 * provider_connections
 *
 * Authorization codes, access and refresh tokens and gateway keys are stored as
 * SHA-256 hashes only. Provider secrets live in `_enc` columns (AES-256-GCM,
 * PROVIDER_TOKEN_ENCRYPTION_KEY). Scope columns hold exactly what was granted;
 * readers never widen them.
 */

import { index, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import type { AgentAvatar } from '@greenhouse/types/agent-avatar';
import { at, createdAt, id, json, jsonOrNull, oneOf, updatedAt } from './_columns.js';
import { users } from './identity.js';

export const OAUTH_CLIENT_AUTH_METHODS = ['none', 'client_secret_post'] as const;
export const OAUTH_CLIENT_STATUSES = ['active', 'disabled'] as const;

export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: id(),
    client_name: text('client_name').notNull(),
    redirect_uris: json<string[]>('redirect_uris', []),
    token_endpoint_auth_method: text('token_endpoint_auth_method', { enum: OAUTH_CLIENT_AUTH_METHODS })
      .notNull()
      .default('none'),
    client_secret_hash: text('client_secret_hash'),
    /** Machine clients act as exactly one member. */
    bound_user_id: text('bound_user_id').references(() => users.id, { onDelete: 'cascade' }),
    allowed_scopes: json<string[]>('allowed_scopes', []),
    status: text('status', { enum: OAUTH_CLIENT_STATUSES }).notNull().default('active'),
    created_by: text('created_by'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    index('idx_oauth_clients_status').on(table.status, table.created_at),
    oneOf('chk_oauth_clients_auth_method', table.token_endpoint_auth_method, OAUTH_CLIENT_AUTH_METHODS),
    oneOf('chk_oauth_clients_status', table.status, OAUTH_CLIENT_STATUSES),
  ],
);

export const OAUTH_GRANT_STATUSES = ['active', 'revoked'] as const;

export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: id(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    resource: text('resource').notNull(),
    scopes: json<string[]>('scopes', []),
    status: text('status', { enum: OAUTH_GRANT_STATUSES }).notNull().default('active'),
    /** Plant avatar the member picked for this connected agent; null = the default for its client. */
    avatar: jsonOrNull<AgentAvatar>('avatar'),
    created_at: createdAt(),
    updated_at: updatedAt(),
    revoked_at: at('revoked_at'),
  },
  (table) => [
    uniqueIndex('uq_oauth_grants_principal').on(table.user_id, table.client_id, table.resource),
    index('idx_oauth_grants_user_status').on(table.user_id, table.status, table.updated_at),
    index('idx_oauth_grants_client').on(table.client_id, table.status),
    oneOf('chk_oauth_grants_status', table.status, OAUTH_GRANT_STATUSES),
  ],
);

export const oauthCodes = pgTable(
  'oauth_codes',
  {
    code_hash: text('code_hash').primaryKey(),
    grant_id: text('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    client_id: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    redirect_uri: text('redirect_uri').notNull(),
    resource: text('resource').notNull(),
    scopes: json<string[]>('scopes', []),
    code_challenge: text('code_challenge').notNull(),
    code_challenge_method: text('code_challenge_method', { enum: ['S256'] })
      .notNull()
      .default('S256'),
    expires_at: at('expires_at').notNull(),
    used_at: at('used_at'),
    created_at: createdAt(),
  },
  (table) => [
    index('idx_oauth_codes_grant').on(table.grant_id),
    index('idx_oauth_codes_expiry').on(table.expires_at),
    oneOf('chk_oauth_codes_method', table.code_challenge_method, ['S256']),
  ],
);

export const OAUTH_TOKEN_TYPES = ['access', 'refresh'] as const;

export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: id(),
    grant_id: text('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    token_hash: text('token_hash').notNull(),
    token_type: text('token_type', { enum: OAUTH_TOKEN_TYPES }).notNull(),
    resource: text('resource').notNull(),
    scopes: json<string[]>('scopes', []),
    expires_at: at('expires_at').notNull(),
    revoked_at: at('revoked_at'),
    last_used_at: at('last_used_at'),
    created_at: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_oauth_tokens_hash').on(table.token_hash),
    index('idx_oauth_tokens_grant_type').on(table.grant_id, table.token_type),
    index('idx_oauth_tokens_expiry').on(table.expires_at),
    oneOf('chk_oauth_tokens_type', table.token_type, OAUTH_TOKEN_TYPES),
  ],
);

/**
 * A member's personal key for the OpenAI-compatible model gateway. The secret is
 * shown once; `key_hash` is its SHA-256, `key_prefix` a visible head. Revoking
 * stamps `revoked_at` and never deletes the row.
 */
export const gatewayKeys = pgTable(
  'gateway_keys',
  {
    id: id(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    key_hash: text('key_hash').notNull(),
    key_prefix: text('key_prefix').notNull(),
    /** Catalog model ids; null = every model the gateway offers. */
    allowed_models: jsonOrNull<string[]>('allowed_models'),
    expires_at: at('expires_at'),
    last_used_at: at('last_used_at'),
    revoked_at: at('revoked_at'),
    revoked_by: text('revoked_by'),
    created_at: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_gateway_keys_hash').on(table.key_hash),
    index('idx_gateway_keys_user').on(table.user_id, table.created_at),
  ],
);

/**
 * A member's binding to a third-party provider (Feishu, WeCom, …), optionally
 * per upstream workspace. Secrets are encrypted; a binding that is an identity
 * rather than a credential leaves them null.
 */
export const providerConnections = pgTable(
  'provider_connections',
  {
    id: id(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    workspace_id: text('workspace_id'),
    access_token_enc: text('access_token_enc'),
    refresh_token_enc: text('refresh_token_enc'),
    credential_enc: text('credential_enc'),
    token_type: text('token_type').notNull().default('Bearer'),
    scope: text('scope'),
    expires_at: at('expires_at'),
    provider_user_id: text('provider_user_id'),
    provider_email: text('provider_email'),
    provider_name: text('provider_name'),
    metadata: json<Record<string, unknown>>('metadata', {}),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    unique('uq_provider_connections_user_workspace')
      .on(table.user_id, table.provider, table.workspace_id)
      .nullsNotDistinct(),
    index('idx_provider_connections_user').on(table.user_id, table.provider),
  ],
);

export type PlatformOAuthClientRow = typeof oauthClients.$inferSelect;
export type PlatformOAuthClientStatus = PlatformOAuthClientRow['status'];
export type PlatformOAuthGrantRow = typeof oauthGrants.$inferSelect;
export type PlatformOAuthAuthorizationCodeRow = typeof oauthCodes.$inferSelect;
export type PlatformOAuthTokenRow = typeof oauthTokens.$inferSelect;
export type GatewayKeyRow = typeof gatewayKeys.$inferSelect;
export type ProviderTokenRow = typeof providerConnections.$inferSelect;
