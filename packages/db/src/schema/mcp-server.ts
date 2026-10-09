/**
 * Drizzle schema — external MCP servers (PostgreSQL).
 *
 * Tables: mcp_servers
 *
 * The CLIENT side of MCP: remote servers ("connectors") a super installed so
 * members can reach their tools through the one `mcp_call` gateway tool
 * (docs/specs/20261009-agent-runtime-hardening.md D5, extended by
 * docs/specs/20261009-mcp-connectors.md). Greenhouse's own MCP SERVER
 * (`/api/mcp`) has nothing to do with this table.
 *
 * A row is the INSTANCE-level half of a connector: where the server is, how it
 * authenticates and what it offers. The PER-MEMBER half — a member's own key or
 * OAuth tokens for `per_user` / `oauth` servers — lives in
 * `user_provider_tokens` under `provider = 'mcp:<id>'` (never the slug: a
 * server re-created under the same slug must not inherit old tokens).
 *
 * Connection settings are plain columns; only secrets are ciphertext (same
 * split as email_accounts). The discovered tool list is a cache of what the
 * server advertised at the last refresh — the model reads it from here so
 * building a chat turn never waits on a remote server.
 */

import { pgTable, serial, text, boolean, timestamp, index, unique, jsonb } from 'drizzle-orm/pg-core';
import type { McpRemoteTool } from '@greenhouse/types/mcp-servers';
import { users } from './user.js';

export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: serial('id').primaryKey(),
    /** The handle the model passes as `server` — unique, never renamed. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** What the server is for, shown to the model next to its tools. */
    description: text('description'),
    /** The MCP endpoint WITHOUT any credential (a query-parameter key is added at connect time). */
    url: text('url').notNull(),
    transport: text('transport', { enum: ['streamable_http', 'sse'] })
      .notNull()
      .default('streamable_http'),
    /**
     * Whose credential a call carries: none (public server), shared (the
     * admin's one credential for everyone), per_user (each member's own key)
     * or oauth (each member signs in, MCP authorization spec).
     */
    auth_mode: text('auth_mode', { enum: ['none', 'shared', 'per_user', 'oauth'] })
      .notNull()
      .default('none'),
    /** Header that carries a shared / per-member credential, e.g. `Authorization`. */
    auth_header: text('auth_header'),
    /** Query parameter that carries it instead (e.g. `key`); exclusive with auth_header. */
    auth_query_param: text('auth_query_param'),
    /** Prepended to the stored value when sent, e.g. `Bearer `. */
    auth_value_prefix: text('auth_value_prefix'),
    /** AES-256-GCM, PROVIDER_TOKEN_ENCRYPTION_KEY — the SHARED credential; never logged, never returned. */
    auth_value_encrypted: text('auth_value_encrypted'),
    /** Shown to members of a per_user server: what to paste and where to get it. */
    credential_help: text('credential_help'),
    credential_url: text('credential_url'),
    /** Scope requested when the server does not advertise one (oauth). */
    oauth_scope: text('oauth_scope'),
    /**
     * The instance's OAuth client at this server's authorization server, as
     * encrypted JSON: dynamically registered, a client-id metadata document, or
     * entered by the admin for servers without registration (GitHub). One per
     * instance, shared by every member's sign-in.
     */
    oauth_client_encrypted: text('oauth_client_encrypted'),
    /** Cached RFC 9728 / RFC 8414 discovery result (public metadata, not a secret). */
    oauth_discovery: jsonb('oauth_discovery').$type<Record<string, unknown> | null>(),
    enabled: boolean('enabled').notNull().default(true),
    /** Tool names members may call; null = every advertised tool. */
    allowed_tools: jsonb('allowed_tools').$type<string[] | null>(),
    /**
     * Tool names a super (or the official catalog) vouches are read-only even
     * though the server does not annotate them (spec 20261009-mcp-connectors D10).
     */
    read_only_tools: jsonb('read_only_tools').$type<string[] | null>(),
    /** The official catalog entry this connector was installed from, if any. */
    catalog_id: text('catalog_id'),
    /** Tools the server advertised at the last successful refresh. */
    tools: jsonb('tools').$type<McpRemoteTool[]>().notNull().default([]),
    tools_refreshed_at: timestamp('tools_refreshed_at', { withTimezone: true, mode: 'string' }),
    /** The last refresh's failure, cleared by the next success. */
    last_error: text('last_error'),
    created_by: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [unique('uq_mcp_servers_slug').on(table.slug), index('idx_mcp_servers_enabled').on(table.enabled)],
);

export type McpServerRow = typeof mcpServers.$inferSelect;
