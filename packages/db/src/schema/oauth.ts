import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, jsonOrNull, updatedAt } from './_columns.js';
import { members } from './identity.js';

/**
 * External access (docs/product/data-model.md §8): outside clients reach /api/mcp as a member
 * through OAuth 2.1, or with a member's personal access token. Codes, tokens and secrets are
 * stored only as keyed hashes.
 */

/** `none`: an interactive client (PKCE, no secret). `client_secret_post`: a machine client with a secret, bound to one member. */
export const OAUTH_AUTH_METHODS = ['none', 'client_secret_post'] as const;
export type OAuthAuthMethod = (typeof OAUTH_AUTH_METHODS)[number];
/** `dynamic`: registered itself (RFC 7591). `admin`: registered by an admin. `builtin`: the personal-token client. */
export const OAUTH_REGISTRATIONS = ['dynamic', 'admin', 'builtin'] as const;
export const OAUTH_GRANT_STATUSES = ['pending', 'active', 'revoked'] as const;
export type OAuthGrantStatus = (typeof OAUTH_GRANT_STATUSES)[number];
export const OAUTH_TOKEN_KINDS = ['access', 'refresh', 'personal'] as const;
export type OAuthTokenKind = (typeof OAUTH_TOKEN_KINDS)[number];

/** The built-in client personal access tokens hang under: one grant per member. */
export const PERSONAL_CLIENT_ID = 'personal';

export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: id(),
    name: text('name').notNull(),
    /** Exact URIs; a loopback one may come back on another port (RFC 8252). */
    redirectUris: json<string[]>('redirect_uris', []),
    authMethod: text('auth_method', { enum: OAUTH_AUTH_METHODS }).notNull().default('none'),
    secretHash: text('secret_hash'),
    /** A machine client acts as this member, once they approve it. */
    boundMemberId: text('bound_member_id').references(() => members.id, { onDelete: 'cascade' }),
    /** The most it may ever be granted; null: whatever the member approves. */
    allowedScopes: jsonOrNull<string[]>('allowed_scopes'),
    registration: text('registration', { enum: OAUTH_REGISTRATIONS }).notNull().default('dynamic'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    createdBy: text('created_by').references(() => members.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('oauth_clients_bound_member_idx').on(t.boundMemberId)],
);

/** A member's authorization of a client for a resource. Scopes are kept exactly as granted. */
export const oauthGrants = pgTable(
  'oauth_grants',
  {
    id: id(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    resource: text('resource').notNull(),
    scopes: json<string[]>('scopes', []),
    /** `pending`: a machine client an admin bound to this member waits for their approval. */
    status: text('status', { enum: OAUTH_GRANT_STATUSES }).notNull().default('active'),
    revokedAt: at('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('oauth_grants_member_client_key').on(t.memberId, t.clientId, t.resource),
    index('oauth_grants_client_idx').on(t.clientId),
  ],
);

/** Authorization codes: PKCE S256, single use, a couple of minutes. */
export const oauthCodes = pgTable(
  'oauth_codes',
  {
    codeHash: text('code_hash').primaryKey(),
    grantId: text('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    scopes: json<string[]>('scopes', []),
    /** The member's sign-in generation when it was issued: a password change spends it. */
    authVersion: integer('auth_version').notNull(),
    expiresAt: at('expires_at').notNull(),
    usedAt: at('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('oauth_codes_grant_idx').on(t.grantId)],
);

/** Access, refresh and personal access tokens. */
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: id(),
    grantId: text('grant_id')
      .notNull()
      .references(() => oauthGrants.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: OAUTH_TOKEN_KINDS }).notNull(),
    /** Personal tokens only. */
    name: text('name'),
    tokenHash: text('token_hash').notNull(),
    resource: text('resource').notNull(),
    scopes: json<string[]>('scopes', []),
    /** Must equal members.auth_version when used: a password change or disabling ends it. */
    authVersion: integer('auth_version').notNull(),
    expiresAt: at('expires_at').notNull(),
    /** A refresh token traded for a new pair; presenting it again is reuse. */
    rotatedAt: at('rotated_at'),
    revokedAt: at('revoked_at'),
    lastUsedAt: at('last_used_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('oauth_tokens_hash_key').on(t.tokenHash), index('oauth_tokens_grant_idx').on(t.grantId)],
);

export type OAuthClient = typeof oauthClients.$inferSelect;
export type OAuthGrant = typeof oauthGrants.$inferSelect;
export type OAuthCode = typeof oauthCodes.$inferSelect;
export type OAuthToken = typeof oauthTokens.$inferSelect;
