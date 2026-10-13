import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, jsonOrNull, updatedAt } from './_columns.js';
import { members } from './identity.js';

/** Remote transports only: a local (stdio) server would be arbitrary code in the API process. */
export const CONNECTOR_TRANSPORTS = ['streamable_http', 'sse'] as const;
export type ConnectorTransport = (typeof CONNECTOR_TRANSPORTS)[number];

/**
 * Whose credential a call carries: nobody's (`none`), the admin's one key for everyone
 * (`shared`), each member's own key (`per_member`), or each member's sign-in (`oauth`).
 */
export const CONNECTOR_AUTH_MODES = ['none', 'shared', 'per_member', 'oauth'] as const;
export type ConnectorAuthMode = (typeof CONNECTOR_AUTH_MODES)[number];

/** One tool as the server advertised it at the last refresh. */
export type ConnectorToolSpec = {
  name: string;
  description: string;
  /** The JSON Schema of its arguments. */
  inputSchema: Record<string, unknown>;
  /** The server's readOnlyHint. */
  readOnly: boolean;
  /** The server's destructiveHint. */
  destructive: boolean;
};

/**
 * MCP servers an admin installed. `authEnc` (the shared key) and `oauthClientEnc` (the client
 * this workspace registered at the server's authorization server) are write-only: no read path
 * returns them. `oauthDiscovery` is public metadata, cached to skip discovery.
 */
export const connectors = pgTable(
  'connectors',
  {
    id: id(),
    /** What the model calls it in mcp_call; never changes. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** The endpoint, never with a credential in it. */
    url: text('url').notNull(),
    transport: text('transport', { enum: CONNECTOR_TRANSPORTS }).notNull().default('streamable_http'),
    authMode: text('auth_mode', { enum: CONNECTOR_AUTH_MODES }).notNull().default('none'),
    /** Where a key goes: a header, or else a query parameter, after an optional prefix (`Bearer `). */
    authHeader: text('auth_header'),
    authQueryParam: text('auth_query_param'),
    authPrefix: text('auth_prefix'),
    authEnc: text('auth_enc'),
    /** What a member pastes for `per_member`, and where to get it. */
    keyHelp: text('key_help').notNull().default(''),
    keyHelpUrl: text('key_help_url'),
    oauthScope: text('oauth_scope'),
    oauthClientEnc: text('oauth_client_enc'),
    oauthDiscovery: jsonOrNull<Record<string, unknown>>('oauth_discovery'),
    /** Tools Agents may call; null means every advertised tool. */
    allowedTools: jsonOrNull<string[]>('allowed_tools'),
    /** Tools vouched read-only although the server does not say so. */
    readOnlyTools: json<string[]>('read_only_tools', []),
    /** The built-in catalog entry it was installed from. */
    catalogId: text('catalog_id'),
    tools: json<ConnectorToolSpec[]>('tools', []),
    toolsRefreshedAt: at('tools_refreshed_at'),
    lastError: text('last_error'),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: text('created_by').references(() => members.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('connectors_slug_key').on(t.slug)],
);

export const CONNECTION_KINDS = ['connector', 'feishu', 'wecom', 'email'] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];
export const CONNECTION_STATUSES = ['active', 'needs_reauth', 'error'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/**
 * A member's external account: a connector key or sign-in, and later their Feishu, WeCom and
 * mailboxes. `secretsEnc` (tokens, a key, a mailbox password) is write-only; `config` holds only
 * plain settings (a mailbox's hosts and ports).
 */
export const connections = pgTable(
  'connections',
  {
    id: id(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: CONNECTION_KINDS }).notNull(),
    /** Set for kind `connector` only. */
    connectorId: text('connector_id').references(() => connectors.id, { onDelete: 'cascade' }),
    /** Feishu open_id, WeCom userid, a mailbox address. */
    externalId: text('external_id'),
    displayName: text('display_name').notNull().default(''),
    config: json<Record<string, unknown>>('config', {}),
    secretsEnc: text('secrets_enc'),
    scopes: json<string[]>('scopes', []),
    /** When the access token runs out (OAuth). */
    expiresAt: at('expires_at'),
    status: text('status', { enum: CONNECTION_STATUSES }).notNull().default('active'),
    lastError: text('last_error'),
    lastVerifiedAt: at('last_verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One connection per member and connector.
    uniqueIndex('connections_member_connector_key')
      .on(t.memberId, t.connectorId)
      .where(sql`${t.kind} = 'connector'`),
    // Feishu and WeCom sign-in find the member by their account.
    uniqueIndex('connections_external_key')
      .on(t.kind, t.externalId)
      .where(sql`${t.kind} IN ('feishu', 'wecom')`),
    index('connections_member_idx').on(t.memberId),
    index('connections_connector_idx').on(t.connectorId),
  ],
);

export type ConnectorRow = typeof connectors.$inferSelect;
export type NewConnectorRow = typeof connectors.$inferInsert;
export type ConnectionRow = typeof connections.$inferSelect;
