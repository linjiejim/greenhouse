/**
 * External MCP server service — the registry behind `mcp_call` (PostgreSQL).
 *
 * Stores what the admin entered plus a cache of the tools each server
 * advertised. Encryption of the auth header value happens in the API (it owns
 * the key); this service only ever sees ciphertext.
 */

import { asc, eq } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { McpRemoteTool } from '@greenhouse/types/mcp-servers';

import type { Db } from '../client.js';
import { mcpServers } from '../schema/index.js';
import type { McpServerRow } from '../schema/mcp-server.js';

export interface McpServerCreateInput {
  slug: string;
  name: string;
  description?: string | null;
  url: string;
  transport?: McpServerRow['transport'];
  auth_header?: string | null;
  auth_value_encrypted?: string | null;
  enabled?: boolean;
  allowed_tools?: string[] | null;
  created_by?: string | null;
}

export type McpServerUpdateInput = Partial<Omit<McpServerCreateInput, 'slug' | 'created_by'>>;

export function createMcpServerService(db: Db) {
  const service = {
    async list(): Promise<McpServerRow[]> {
      return await db.select().from(mcpServers).orderBy(asc(mcpServers.slug));
    },

    async listEnabled(): Promise<McpServerRow[]> {
      return await db.select().from(mcpServers).where(eq(mcpServers.enabled, true)).orderBy(asc(mcpServers.slug));
    },

    async getById(id: number): Promise<McpServerRow | undefined> {
      const rows = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
      return rows[0];
    },

    async getBySlug(slug: string): Promise<McpServerRow | undefined> {
      const rows = await db.select().from(mcpServers).where(eq(mcpServers.slug, slug));
      return rows[0];
    },

    /** Insert; a duplicate slug returns undefined (the unique key arbitrates). */
    async create(input: McpServerCreateInput): Promise<McpServerRow | undefined> {
      const now = nowIso();
      const rows = await db
        .insert(mcpServers)
        .values({
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          url: input.url,
          transport: input.transport ?? 'streamable_http',
          auth_header: input.auth_header ?? null,
          auth_value_encrypted: input.auth_value_encrypted ?? null,
          enabled: input.enabled ?? true,
          allowed_tools: input.allowed_tools ?? null,
          tools: [],
          created_by: input.created_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing({ target: mcpServers.slug })
        .returning();
      return rows[0];
    },

    async update(id: number, input: McpServerUpdateInput): Promise<McpServerRow | undefined> {
      const set: Partial<typeof mcpServers.$inferInsert> = { updated_at: nowIso() };
      if (input.name !== undefined) set.name = input.name;
      if (input.description !== undefined) set.description = input.description;
      if (input.url !== undefined) set.url = input.url;
      if (input.transport !== undefined) set.transport = input.transport;
      if (input.auth_header !== undefined) set.auth_header = input.auth_header;
      if (input.auth_value_encrypted !== undefined) set.auth_value_encrypted = input.auth_value_encrypted;
      if (input.enabled !== undefined) set.enabled = input.enabled;
      if (input.allowed_tools !== undefined) set.allowed_tools = input.allowed_tools;
      const rows = await db.update(mcpServers).set(set).where(eq(mcpServers.id, id)).returning();
      return rows[0];
    },

    /** Record a refresh: the advertised tools on success, the error (tools kept) on failure. */
    async recordRefresh(
      id: number,
      result: { ok: true; tools: McpRemoteTool[] } | { ok: false; error: string },
    ): Promise<McpServerRow | undefined> {
      const now = nowIso();
      const set: Partial<typeof mcpServers.$inferInsert> = result.ok
        ? { tools: result.tools, tools_refreshed_at: now, last_error: null }
        : { last_error: result.error };
      const rows = await db.update(mcpServers).set(set).where(eq(mcpServers.id, id)).returning();
      return rows[0];
    },

    async remove(id: number): Promise<boolean> {
      const rows = await db.delete(mcpServers).where(eq(mcpServers.id, id)).returning({ id: mcpServers.id });
      return rows.length > 0;
    },
  };
  return service;
}

export type McpServerService = ReturnType<typeof createMcpServerService>;
