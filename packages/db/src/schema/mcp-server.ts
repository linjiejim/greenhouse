/**
 * Drizzle schema — external MCP servers (PostgreSQL).
 *
 * Tables: mcp_servers
 *
 * The CLIENT side of MCP: remote servers a super registered so members can
 * reach their tools from chat through the one `mcp_call` gateway tool
 * (docs/specs/20261009-agent-runtime-hardening.md D5). Greenhouse's own MCP
 * SERVER (`/api/mcp`) has nothing to do with this table.
 *
 * Connection settings are plain columns; only the auth header's VALUE is
 * ciphertext (same split as email_accounts). The discovered tool list is a
 * cache of what the server advertised at the last refresh — the model reads it
 * from here so building a chat turn never waits on a remote server.
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
    url: text('url').notNull(),
    transport: text('transport', { enum: ['streamable_http', 'sse'] })
      .notNull()
      .default('streamable_http'),
    /** Header that carries the credential, e.g. `Authorization`. */
    auth_header: text('auth_header'),
    /** AES-256-GCM, PROVIDER_TOKEN_ENCRYPTION_KEY — the full header value; never logged, never returned. */
    auth_value_encrypted: text('auth_value_encrypted'),
    enabled: boolean('enabled').notNull().default(true),
    /** Tool names members may call; null = every advertised tool. */
    allowed_tools: jsonb('allowed_tools').$type<string[] | null>(),
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
