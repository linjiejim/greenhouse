/**
 * MCP connectors — remote MCP servers members' agents call through `mcp_call`.
 *
 * Tables: mcp_connectors
 *
 * The CLIENT side of MCP; Greenhouse's own MCP server (`/api/mcp`) has nothing
 * to do with this table. A row is a connector's instance-level half: where the
 * server is, how it authenticates, which tools are switched on and what it
 * advertised at the last refresh (read from here so a chat turn never waits on
 * a remote server).
 *
 * The per-member half — a member's own key or OAuth tokens — lives in
 * `provider_connections` under `provider = 'mcp:<connector id>'` (by id, never
 * the slug: a connector re-created under the same slug must not inherit old
 * credentials). Its status (active / needs_reauth / error), last_error and
 * last_verified_at ride in that row's metadata.
 *
 * Secrets are ciphertext bound to where they live (AES-GCM AAD):
 * `shared_secret_enc` → `mcp:<id>:shared`, `oauth_client_enc` → `mcp:<id>:oauth-client`.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import type { ConnectorTool } from '@greenhouse/types/connectors';
import { at, createdAt, id, json, jsonOrNull, oneOf, updatedAt } from './_columns.js';
import { users } from './identity.js';

export const MCP_CONNECTOR_SCOPES = ['team', 'personal'] as const;
export const MCP_CONNECTOR_TRANSPORTS = ['streamable_http', 'sse'] as const;
export const MCP_CONNECTOR_AUTH_MODES = ['none', 'shared', 'per_member'] as const;
export const MCP_CONNECTOR_AUTH_KINDS = ['key', 'oauth'] as const;

export const mcpConnectors = pgTable(
  'mcp_connectors',
  {
    id: id(),
    scope: text('scope', { enum: MCP_CONNECTOR_SCOPES }).notNull(),
    /** Personal connectors only (required there); team connectors leave it null. */
    owner_user_id: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** The model's handle (`me/<slug>` for a personal one); never renamed. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** The MCP endpoint WITHOUT any credential (a query-parameter key is added at connect time). */
    url: text('url').notNull(),
    transport: text('transport', { enum: MCP_CONNECTOR_TRANSPORTS }).notNull().default('streamable_http'),
    auth_mode: text('auth_mode', { enum: MCP_CONNECTOR_AUTH_MODES }).notNull().default('none'),
    auth_kind: text('auth_kind', { enum: MCP_CONNECTOR_AUTH_KINDS }),
    /** Header that carries a key (default `Authorization`); exclusive with auth_query_param. */
    auth_header: text('auth_header'),
    auth_query_param: text('auth_query_param'),
    /** Prepended to the key when sent, e.g. `Bearer `. */
    auth_value_prefix: text('auth_value_prefix'),
    /** The team credential: a shared key, or the JSON of a super's shared OAuth sign-in. Never returned. */
    shared_secret_enc: text('shared_secret_enc'),
    /** The instance's OAuth client at this server (JSON), registered or entered by hand. */
    oauth_client_enc: text('oauth_client_enc'),
    /** Cached RFC 9728 / RFC 8414 discovery (public metadata). */
    oauth_discovery: jsonOrNull<Record<string, unknown>>('oauth_discovery'),
    oauth_scope: text('oauth_scope'),
    /** Team only, set by a super: the configured host may be a private address. */
    private_network: boolean('private_network').notNull().default(false),
    /** Members' external agents (`/api/mcp`) may call this connector's write tools with the shared credential. */
    allow_external_writes: boolean('allow_external_writes').notNull().default(false),
    /** `{ "<tool>": "on" | "off" }`; unlisted tools follow the default (read-only on, others off). */
    tool_policy: json<Record<string, 'on' | 'off'>>('tool_policy', {}),
    /** Tools an admin (or the catalog) vouches are read-only though the server does not say so. */
    vouched_read_only: text('vouched_read_only')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** What the server advertised at the last successful refresh. */
    tools: json<ConnectorTool[]>('tools', []),
    tools_refreshed_at: at('tools_refreshed_at'),
    /** The last refresh's failure, cleared by the next success. */
    last_error: text('last_error'),
    enabled: boolean('enabled').notNull().default(true),
    /** The official catalog entry it was added from, if any. */
    catalog_id: text('catalog_id'),
    created_by: text('created_by'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    unique('uq_mcp_connectors_scope_owner_slug').on(table.scope, table.owner_user_id, table.slug).nullsNotDistinct(),
    index('idx_mcp_connectors_owner').on(table.owner_user_id),
    oneOf('chk_mcp_connectors_scope', table.scope, MCP_CONNECTOR_SCOPES),
    oneOf('chk_mcp_connectors_transport', table.transport, MCP_CONNECTOR_TRANSPORTS),
    oneOf('chk_mcp_connectors_auth_mode', table.auth_mode, MCP_CONNECTOR_AUTH_MODES),
    oneOf('chk_mcp_connectors_auth_kind', table.auth_kind, MCP_CONNECTOR_AUTH_KINDS),
    check(
      'chk_mcp_connectors_owner',
      sql`(${table.scope} = 'personal' AND ${table.owner_user_id} IS NOT NULL) OR (${table.scope} = 'team' AND ${table.owner_user_id} IS NULL)`,
    ),
    check(
      'chk_mcp_connectors_personal',
      sql`${table.scope} = 'team' OR (${table.auth_mode} IN ('none', 'per_member') AND ${table.private_network} = false)`,
    ),
  ],
);

export type McpConnectorRow = typeof mcpConnectors.$inferSelect;
export type McpConnectorScope = McpConnectorRow['scope'];
export type McpConnectorAuthMode = McpConnectorRow['auth_mode'];
