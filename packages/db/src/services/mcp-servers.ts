/**
 * External MCP server service — the connectors behind `mcp_call` (PostgreSQL).
 *
 * Two halves (spec 20261009-mcp-connectors D1):
 * - the CONNECTOR: what the admin installed plus a cache of the tools the
 *   server advertised (`mcp_servers`);
 * - a member's CONNECTION to it: their own key or OAuth tokens, stored in the
 *   generic per-user token store (`user_provider_tokens`) under
 *   `provider = 'mcp:<server id>'`. That key convention lives only in this file.
 *
 * Encryption happens in the API (it owns the key); this service only ever sees
 * ciphertext.
 */

import { and, asc, eq, like, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { McpAuthMode, McpRemoteTool } from '@greenhouse/types/mcp-servers';

import type { Db } from '../client.js';
import { mcpServers, userProviderTokens } from '../schema/index.js';
import type { McpServerRow } from '../schema/mcp-server.js';
import type { ProviderTokenRow } from '../schema/provider-token.js';

export interface McpServerCreateInput {
  slug: string;
  name: string;
  description?: string | null;
  url: string;
  transport?: McpServerRow['transport'];
  auth_mode?: McpAuthMode;
  auth_header?: string | null;
  auth_query_param?: string | null;
  auth_value_prefix?: string | null;
  auth_value_encrypted?: string | null;
  credential_help?: string | null;
  credential_url?: string | null;
  oauth_scope?: string | null;
  oauth_client_encrypted?: string | null;
  enabled?: boolean;
  allowed_tools?: string[] | null;
  read_only_tools?: string[] | null;
  catalog_id?: string | null;
  created_by?: string | null;
}

export type McpServerUpdateInput = Partial<Omit<McpServerCreateInput, 'slug' | 'created_by' | 'catalog_id'>>;

/** The token-store provider key of a member's connection to server `id`. */
export function mcpConnectionProvider(serverId: number): string {
  return `mcp:${serverId}`;
}

/** The server id a connection's provider key names, or null for any other provider. */
export function serverIdOfConnectionProvider(provider: string): number | null {
  const match = /^mcp:(\d+)$/.exec(provider);
  return match ? Number(match[1]) : null;
}

/** A member's connection as stored — every credential is ciphertext. */
export interface McpConnectionWrite {
  access_token?: string | null;
  refresh_token?: string | null;
  token_type?: string;
  scope?: string | null;
  expires_at?: string | null;
  /** A per_user server's key. */
  credential?: string | null;
  metadata?: Record<string, unknown>;
}

export function createMcpServerService(db: Db) {
  function connectionWhere(userId: string, serverId: number) {
    return and(
      eq(userProviderTokens.user_id, userId),
      eq(userProviderTokens.provider, mcpConnectionProvider(serverId)),
      sql`${userProviderTokens.workspace_id} IS NULL`,
    );
  }

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
          auth_mode: input.auth_mode ?? 'none',
          auth_header: input.auth_header ?? null,
          auth_query_param: input.auth_query_param ?? null,
          auth_value_prefix: input.auth_value_prefix ?? null,
          auth_value_encrypted: input.auth_value_encrypted ?? null,
          credential_help: input.credential_help ?? null,
          credential_url: input.credential_url ?? null,
          oauth_scope: input.oauth_scope ?? null,
          oauth_client_encrypted: input.oauth_client_encrypted ?? null,
          enabled: input.enabled ?? true,
          allowed_tools: input.allowed_tools ?? null,
          read_only_tools: input.read_only_tools ?? null,
          catalog_id: input.catalog_id ?? null,
          tools: [],
          created_by: input.created_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing({ target: mcpServers.slug })
        .returning();
      return rows[0];
    },

    /**
     * Update the connector. With `resetConnections`, every member's connection,
     * the instance's OAuth client and the discovery cache go too — in the same
     * transaction: they were issued for the old address / auth mode (spec D1).
     */
    async update(
      id: number,
      input: McpServerUpdateInput,
      opts: { resetConnections?: boolean } = {},
    ): Promise<McpServerRow | undefined> {
      const set: Partial<typeof mcpServers.$inferInsert> = { updated_at: nowIso() };
      if (input.name !== undefined) set.name = input.name;
      if (input.description !== undefined) set.description = input.description;
      if (input.url !== undefined) set.url = input.url;
      if (input.transport !== undefined) set.transport = input.transport;
      if (input.auth_mode !== undefined) set.auth_mode = input.auth_mode;
      if (input.auth_header !== undefined) set.auth_header = input.auth_header;
      if (input.auth_query_param !== undefined) set.auth_query_param = input.auth_query_param;
      if (input.auth_value_prefix !== undefined) set.auth_value_prefix = input.auth_value_prefix;
      if (input.auth_value_encrypted !== undefined) set.auth_value_encrypted = input.auth_value_encrypted;
      if (input.credential_help !== undefined) set.credential_help = input.credential_help;
      if (input.credential_url !== undefined) set.credential_url = input.credential_url;
      if (input.oauth_scope !== undefined) set.oauth_scope = input.oauth_scope;
      if (input.oauth_client_encrypted !== undefined) set.oauth_client_encrypted = input.oauth_client_encrypted;
      if (input.enabled !== undefined) set.enabled = input.enabled;
      if (input.allowed_tools !== undefined) set.allowed_tools = input.allowed_tools;
      if (input.read_only_tools !== undefined) set.read_only_tools = input.read_only_tools;
      if (!opts.resetConnections) {
        const rows = await db.update(mcpServers).set(set).where(eq(mcpServers.id, id)).returning();
        return rows[0];
      }
      return db.transaction(async (tx) => {
        // A manual client the same update sets survives; a registered one does not.
        if (input.oauth_client_encrypted === undefined) set.oauth_client_encrypted = null;
        set.oauth_discovery = null;
        set.tools = [];
        set.tools_refreshed_at = null;
        const rows = await tx.update(mcpServers).set(set).where(eq(mcpServers.id, id)).returning();
        if (rows[0]) {
          await tx.delete(userProviderTokens).where(eq(userProviderTokens.provider, mcpConnectionProvider(id)));
        }
        return rows[0];
      });
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

    /** Store (or clear) the instance's OAuth client at this server. Not an edit: `updated_at` stays. */
    async setOAuthClient(id: number, ciphertext: string | null): Promise<void> {
      await db.update(mcpServers).set({ oauth_client_encrypted: ciphertext }).where(eq(mcpServers.id, id));
    },

    /** Cache (or clear) the server's OAuth discovery result. */
    async setOAuthDiscovery(id: number, discovery: Record<string, unknown> | null): Promise<void> {
      await db.update(mcpServers).set({ oauth_discovery: discovery }).where(eq(mcpServers.id, id));
    },

    /** Remove the connector and every member's connection to it. */
    async remove(id: number): Promise<boolean> {
      return db.transaction(async (tx) => {
        const rows = await tx.delete(mcpServers).where(eq(mcpServers.id, id)).returning({ id: mcpServers.id });
        if (rows.length === 0) return false;
        await tx.delete(userProviderTokens).where(eq(userProviderTokens.provider, mcpConnectionProvider(id)));
        return true;
      });
    },

    // ─── Members' connections ─────────────────────────

    async getConnection(userId: string, serverId: number): Promise<ProviderTokenRow | undefined> {
      const rows = await db.select().from(userProviderTokens).where(connectionWhere(userId, serverId));
      return rows[0];
    },

    /** Every connection a member holds (any server, including disabled ones). */
    async listConnections(userId: string): Promise<ProviderTokenRow[]> {
      return await db
        .select()
        .from(userProviderTokens)
        .where(and(eq(userProviderTokens.user_id, userId), like(userProviderTokens.provider, 'mcp:%')));
    },

    /**
     * Create or replace a member's connection. Fields left undefined are cleared
     * on replace — a connection is always written whole (a new sign-in or a new key).
     */
    async saveConnection(userId: string, serverId: number, input: McpConnectionWrite): Promise<ProviderTokenRow> {
      const now = nowIso();
      const values = {
        access_token: input.access_token ?? null,
        refresh_token: input.refresh_token ?? null,
        token_type: input.token_type ?? 'Bearer',
        scope: input.scope ?? null,
        expires_at: input.expires_at ?? null,
        provider_credential: input.credential ?? null,
        metadata: JSON.stringify(input.metadata ?? {}),
      };
      const rows = await db
        .insert(userProviderTokens)
        .values({
          user_id: userId,
          provider: mcpConnectionProvider(serverId),
          workspace_id: null,
          ...values,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [userProviderTokens.user_id, userProviderTokens.provider, userProviderTokens.workspace_id],
          set: { ...values, updated_at: now },
        })
        .returning();
      return rows[0]!;
    },

    /**
     * Replace the tokens after a refresh, but only while the row still holds
     * `expectedAccessToken` — two processes refreshing at once must not let the
     * loser overwrite the winner's rotated refresh token. Returns whether it wrote.
     */
    async updateConnectionTokens(
      userId: string,
      serverId: number,
      expectedAccessToken: string | null,
      tokens: Pick<McpConnectionWrite, 'access_token' | 'refresh_token' | 'token_type' | 'scope' | 'expires_at'>,
    ): Promise<boolean> {
      const set: Partial<typeof userProviderTokens.$inferInsert> = { updated_at: nowIso() };
      if (tokens.access_token !== undefined) set.access_token = tokens.access_token;
      if (tokens.refresh_token !== undefined) set.refresh_token = tokens.refresh_token;
      if (tokens.token_type !== undefined) set.token_type = tokens.token_type;
      if (tokens.scope !== undefined) set.scope = tokens.scope;
      if (tokens.expires_at !== undefined) set.expires_at = tokens.expires_at;
      const guard =
        expectedAccessToken === null
          ? sql`${userProviderTokens.access_token} IS NULL`
          : eq(userProviderTokens.access_token, expectedAccessToken);
      const rows = await db
        .update(userProviderTokens)
        .set(set)
        .where(and(connectionWhere(userId, serverId), guard))
        .returning({ id: userProviderTokens.id });
      return rows.length > 0;
    },

    /**
     * The sign-in stopped working: drop the tokens, keep the row with the reason
     * so the member sees "reconnect" rather than "never connected".
     */
    async expireConnection(userId: string, serverId: number, reason: string): Promise<void> {
      await db
        .update(userProviderTokens)
        .set({
          access_token: null,
          refresh_token: null,
          expires_at: null,
          metadata: JSON.stringify({ error: reason }),
          updated_at: nowIso(),
        })
        .where(connectionWhere(userId, serverId));
    },

    async deleteConnection(userId: string, serverId: number): Promise<boolean> {
      const rows = await db
        .delete(userProviderTokens)
        .where(connectionWhere(userId, serverId))
        .returning({ id: userProviderTokens.id });
      return rows.length > 0;
    },

    /** How many members hold a usable connection, per server id. */
    async connectionCounts(): Promise<Map<number, number>> {
      const rows = await db
        .select({ provider: userProviderTokens.provider, n: sql<string>`count(*)` })
        .from(userProviderTokens)
        .where(
          and(
            like(userProviderTokens.provider, 'mcp:%'),
            sql`(${userProviderTokens.access_token} IS NOT NULL OR ${userProviderTokens.provider_credential} IS NOT NULL)`,
          ),
        )
        .groupBy(userProviderTokens.provider);
      const counts = new Map<number, number>();
      for (const row of rows) {
        const id = serverIdOfConnectionProvider(row.provider);
        if (id !== null) counts.set(id, Number(row.n));
      }
      return counts;
    },
  };
  return service;
}

export type McpServerService = ReturnType<typeof createMcpServerService>;
