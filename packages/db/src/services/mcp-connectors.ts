/**
 * MCP connectors (PostgreSQL) — `mcp_connectors` plus members' credentials in
 * `provider_connections` (`provider = 'mcp:<connector id>'`).
 *
 * Values arrive and leave sealed: encryption (with AAD) happens in the API's
 * connector layer; this service only stores ciphertext. Status of a member's
 * connection (`active` / `needs_reauth` / `error`), its last error and the time
 * it last worked live in the connection row's metadata.
 *
 * Changing a connector's address or how it authenticates, and deleting it,
 * drop every member credential in the same transaction: a credential is only
 * ever valid for the server and the scheme it was given for.
 */

import { and, asc, eq, inArray, isNull, like, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { ConnectorTool } from '@greenhouse/types/connectors';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { mcpConnectors, providerConnections } from '../schema/index.js';
import type { McpConnectorRow, ProviderTokenRow } from '../schema/index.js';

/** The provider key of a member's credential for one connector. */
export function mcpConnectionProvider(connectorId: string): string {
  return `mcp:${connectorId}`;
}

export type McpConnectionStatus = 'active' | 'needs_reauth' | 'error';

export interface McpConnectorCreate {
  scope: McpConnectorRow['scope'];
  owner_user_id?: string | null;
  slug: string;
  name: string;
  description?: string | null;
  url: string;
  transport?: McpConnectorRow['transport'];
  auth_mode?: McpConnectorRow['auth_mode'];
  auth_kind?: McpConnectorRow['auth_kind'];
  auth_header?: string | null;
  auth_query_param?: string | null;
  auth_value_prefix?: string | null;
  shared_secret_enc?: string | null;
  oauth_client_enc?: string | null;
  oauth_scope?: string | null;
  private_network?: boolean;
  allow_external_writes?: boolean;
  tool_policy?: Record<string, 'on' | 'off'>;
  vouched_read_only?: string[];
  enabled?: boolean;
  catalog_id?: string | null;
  created_by?: string | null;
}

export type McpConnectorPatch = Partial<
  Omit<McpConnectorCreate, 'scope' | 'owner_user_id' | 'slug' | 'created_by'> & {
    oauth_discovery: Record<string, unknown> | null;
    tools: ConnectorTool[];
    tools_refreshed_at: string | null;
    last_error: string | null;
  }
>;

export interface McpConnectionInput {
  access_token?: string | null;
  refresh_token?: string | null;
  credential?: string | null;
  token_type?: string;
  scope?: string | null;
  expires_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface McpConnectionTokens {
  access_token: string;
  refresh_token?: string | null;
  token_type?: string;
  scope?: string | null;
  expires_at?: string | null;
}

const PROVIDER_PREFIX = 'mcp:';

function connectionWhere(userId: string, connectorId: string) {
  return and(
    eq(providerConnections.user_id, userId),
    eq(providerConnections.provider, mcpConnectionProvider(connectorId)),
    isNull(providerConnections.workspace_id),
  );
}

/** What a credential write is guarded by: the connector still has this address and auth scheme. */
export type McpCredentialGuard = Pick<McpConnectorRow, 'url' | 'auth_mode' | 'auth_kind'>;

function guardWhere(guard: McpCredentialGuard) {
  return and(
    eq(mcpConnectors.url, guard.url),
    eq(mcpConnectors.auth_mode, guard.auth_mode),
    guard.auth_kind === null ? isNull(mcpConnectors.auth_kind) : eq(mcpConnectors.auth_kind, guard.auth_kind),
  );
}

async function writeConnection(
  db: Pick<Db, 'insert'>,
  userId: string,
  connectorId: string,
  input: McpConnectionInput,
): Promise<ProviderTokenRow> {
  const now = nowIso();

  const metadata = { ...(input.metadata ?? {}), status: 'active', last_error: null, last_verified_at: now };
  const values = {
    access_token_enc: input.access_token ?? null,
    refresh_token_enc: input.refresh_token ?? null,
    credential_enc: input.credential ?? null,
    token_type: input.token_type ?? 'Bearer',
    scope: input.scope ?? null,
    expires_at: input.expires_at ?? null,
    metadata,
  };
  const [row] = await db
    .insert(providerConnections)
    .values({
      id: newId('providerConnection'),
      user_id: userId,
      provider: mcpConnectionProvider(connectorId),
      workspace_id: null,
      ...values,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [providerConnections.user_id, providerConnections.provider, providerConnections.workspace_id],
      set: { ...values, created_at: now, updated_at: now },
    })
    .returning();
  return row!;
}

export function createMcpConnectorService(db: Db) {
  const service = {
    async create(input: McpConnectorCreate): Promise<McpConnectorRow> {
      const now = nowIso();
      const [row] = await db
        .insert(mcpConnectors)
        .values({
          id: newId('mcpConnector'),
          scope: input.scope,
          owner_user_id: input.scope === 'personal' ? (input.owner_user_id ?? null) : null,
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          url: input.url,
          transport: input.transport ?? 'streamable_http',
          auth_mode: input.auth_mode ?? 'none',
          auth_kind: input.auth_kind ?? null,
          auth_header: input.auth_header ?? null,
          auth_query_param: input.auth_query_param ?? null,
          auth_value_prefix: input.auth_value_prefix ?? null,
          shared_secret_enc: input.shared_secret_enc ?? null,
          oauth_client_enc: input.oauth_client_enc ?? null,
          oauth_scope: input.oauth_scope ?? null,
          private_network: input.private_network ?? false,
          allow_external_writes: input.allow_external_writes ?? false,
          tool_policy: input.tool_policy ?? {},
          vouched_read_only: input.vouched_read_only ?? [],
          enabled: input.enabled ?? true,
          catalog_id: input.catalog_id ?? null,
          created_by: input.created_by ?? null,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async getById(id: string): Promise<McpConnectorRow | undefined> {
      const [row] = await db.select().from(mcpConnectors).where(eq(mcpConnectors.id, id)).limit(1);
      return row;
    },

    async listTeam(): Promise<McpConnectorRow[]> {
      return db.select().from(mcpConnectors).where(eq(mcpConnectors.scope, 'team')).orderBy(asc(mcpConnectors.slug));
    },

    async listPersonal(ownerUserId: string): Promise<McpConnectorRow[]> {
      return db
        .select()
        .from(mcpConnectors)
        .where(and(eq(mcpConnectors.scope, 'personal'), eq(mcpConnectors.owner_user_id, ownerUserId)))
        .orderBy(asc(mcpConnectors.slug));
    },

    /** Every enabled connector (team and personal) — the in-memory directory's source. */
    async listEnabled(): Promise<McpConnectorRow[]> {
      return db.select().from(mcpConnectors).where(eq(mcpConnectors.enabled, true)).orderBy(asc(mcpConnectors.slug));
    },

    /**
     * Apply a patch. `dropCredentials` deletes every member credential (and,
     * for the server's own OAuth state, the shared sign-in, the registered
     * client and the cached discovery) in the same transaction — used when the
     * address or the auth scheme changes.
     */
    async update(
      id: string,
      patch: McpConnectorPatch,
      opts: { dropCredentials?: boolean } = {},
    ): Promise<McpConnectorRow | undefined> {
      return db.transaction(async (tx) => {
        const set: Record<string, unknown> = { ...patch, updated_at: nowIso() };
        // Row first: its lock makes a sign-in finishing meanwhile wait, then see the change (saveConnection's guard).
        const [row] = await tx.update(mcpConnectors).set(set).where(eq(mcpConnectors.id, id)).returning();
        if (opts.dropCredentials) {
          await tx.delete(providerConnections).where(eq(providerConnections.provider, mcpConnectionProvider(id)));
        }
        return row;
      });
    },

    /** Delete a connector and every member credential for it, together. */
    async delete(id: string): Promise<McpConnectorRow | undefined> {
      return db.transaction(async (tx) => {
        await tx.delete(providerConnections).where(eq(providerConnections.provider, mcpConnectionProvider(id)));
        const [row] = await tx.delete(mcpConnectors).where(eq(mcpConnectors.id, id)).returning();
        return row;
      });
    },

    /** Record a refresh: new tools on success, the reason on failure (the old tool list survives). */
    async recordRefresh(
      id: string,
      outcome: { ok: true; tools: ConnectorTool[] } | { ok: false; error: string },
    ): Promise<McpConnectorRow | undefined> {
      const now = nowIso();
      const set = outcome.ok
        ? { tools: outcome.tools, tools_refreshed_at: now, last_error: null, updated_at: now }
        : { last_error: outcome.error.slice(0, 1000), updated_at: now };
      const [row] = await db.update(mcpConnectors).set(set).where(eq(mcpConnectors.id, id)).returning();
      return row;
    },

    /** With `expected` it is a compare-and-set: false when another sign-in registered a client first. */
    async setOAuthClient(id: string, sealed: string | null, expected?: string | null): Promise<boolean> {
      const where =
        expected === undefined
          ? eq(mcpConnectors.id, id)
          : expected === null
            ? and(eq(mcpConnectors.id, id), isNull(mcpConnectors.oauth_client_enc))
            : and(eq(mcpConnectors.id, id), eq(mcpConnectors.oauth_client_enc, expected));
      const rows = await db
        .update(mcpConnectors)
        .set({ oauth_client_enc: sealed, updated_at: nowIso() })
        .where(where)
        .returning({ id: mcpConnectors.id });
      return rows.length > 0;
    },

    async setOAuthDiscovery(id: string, discovery: Record<string, unknown> | null): Promise<void> {
      await db.update(mcpConnectors).set({ oauth_discovery: discovery }).where(eq(mcpConnectors.id, id));
    },

    /**
     * Replace the shared credential. With `expected` it is a compare-and-set
     * (a refreshed shared sign-in only overwrites the tokens it read).
     */
    async setSharedSecret(
      id: string,
      sealed: string | null,
      expected?: string | null,
      guard?: McpCredentialGuard,
    ): Promise<boolean> {
      const base = guard ? and(eq(mcpConnectors.id, id), guardWhere(guard)) : eq(mcpConnectors.id, id);
      const where =
        expected === undefined
          ? base
          : expected === null
            ? and(base, isNull(mcpConnectors.shared_secret_enc))
            : and(base, eq(mcpConnectors.shared_secret_enc, expected));
      const rows = await db
        .update(mcpConnectors)
        .set({ shared_secret_enc: sealed, updated_at: nowIso() })
        .where(where)
        .returning({ id: mcpConnectors.id });
      return rows.length > 0;
    },

    // ─── Members' connections ────────────────────────────

    async getConnection(userId: string, connectorId: string): Promise<ProviderTokenRow | undefined> {
      const [row] = await db.select().from(providerConnections).where(connectionWhere(userId, connectorId)).limit(1);
      return row;
    },

    /**
     * Store (or replace) a member's credential; status becomes active. With
     * `guard`, only while the connector still has that address and auth scheme
     * (undefined otherwise): a sign-in that started before a change must not
     * land after the change dropped every credential.
     */
    async saveConnection(
      userId: string,
      connectorId: string,
      input: McpConnectionInput,
      guard?: McpCredentialGuard,
    ): Promise<ProviderTokenRow | undefined> {
      if (guard) {
        return db.transaction(async (tx) => {
          const [held] = await tx
            .select({ id: mcpConnectors.id })
            .from(mcpConnectors)
            .where(and(eq(mcpConnectors.id, connectorId), guardWhere(guard)))
            .for('update');
          if (!held) return undefined;
          return writeConnection(tx, userId, connectorId, input);
        });
      }
      return writeConnection(db, userId, connectorId, input);
    },

    /**
     * A refresh: write only over the access token this request read. False
     * when another request refreshed first (its rotated tokens win).
     */
    async updateConnectionTokens(
      userId: string,
      connectorId: string,
      expectedAccessToken: string | null,
      tokens: McpConnectionTokens,
    ): Promise<boolean> {
      const now = nowIso();
      const rows = await db
        .update(providerConnections)
        .set({
          access_token_enc: tokens.access_token,
          ...(tokens.refresh_token !== undefined ? { refresh_token_enc: tokens.refresh_token } : {}),
          ...(tokens.token_type ? { token_type: tokens.token_type } : {}),
          ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
          ...(tokens.expires_at !== undefined ? { expires_at: tokens.expires_at } : {}),
          metadata: sql`${providerConnections.metadata} || ${JSON.stringify({ status: 'active', last_error: null, last_verified_at: now })}::jsonb`,
          updated_at: now,
        })
        .where(
          and(
            connectionWhere(userId, connectorId),
            expectedAccessToken === null
              ? isNull(providerConnections.access_token_enc)
              : eq(providerConnections.access_token_enc, expectedAccessToken),
          ),
        )
        .returning({ id: providerConnections.id });
      return rows.length > 0;
    },

    /** Record how a member's connection stands; `active` also stamps last_verified_at. */
    async markConnection(
      userId: string,
      connectorId: string,
      status: McpConnectionStatus,
      error: string | null = null,
    ): Promise<void> {
      const patch: Record<string, unknown> = { status, last_error: error ? error.slice(0, 500) : null };
      if (status === 'active') patch.last_verified_at = nowIso();
      await db
        .update(providerConnections)
        .set({
          metadata: sql`${providerConnections.metadata} || ${JSON.stringify(patch)}::jsonb`,
          updated_at: nowIso(),
        })
        .where(connectionWhere(userId, connectorId));
    },

    /** Mark a sign-in that stopped working — only if it is still the one that failed. */
    async expireConnection(userId: string, connectorId: string, expectedAccessToken: string, reason: string) {
      await db
        .update(providerConnections)
        .set({
          metadata: sql`${providerConnections.metadata} || ${JSON.stringify({ status: 'needs_reauth', last_error: reason.slice(0, 500) })}::jsonb`,
          updated_at: nowIso(),
        })
        .where(
          and(connectionWhere(userId, connectorId), eq(providerConnections.access_token_enc, expectedAccessToken)),
        );
    },

    async deleteConnection(userId: string, connectorId: string): Promise<ProviderTokenRow | undefined> {
      const [row] = await db.delete(providerConnections).where(connectionWhere(userId, connectorId)).returning();
      return row;
    },

    /** A member's connector credentials (any connector). */
    async listConnectionsForUser(userId: string): Promise<ProviderTokenRow[]> {
      return db
        .select()
        .from(providerConnections)
        .where(and(eq(providerConnections.user_id, userId), like(providerConnections.provider, `${PROVIDER_PREFIX}%`)));
    },

    /** Every member credential for one connector (revocation before a delete). */
    async listConnectionsForConnector(connectorId: string): Promise<ProviderTokenRow[]> {
      return db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.provider, mcpConnectionProvider(connectorId)));
    },

    /** Members holding a credential, per connector. */
    async countConnections(connectorIds: readonly string[]): Promise<Map<string, number>> {
      const counts = new Map<string, number>();
      if (connectorIds.length === 0) return counts;
      const rows = await db
        .select({ provider: providerConnections.provider, count: sql<number>`count(*)::int` })
        .from(providerConnections)
        .where(inArray(providerConnections.provider, connectorIds.map(mcpConnectionProvider)))
        .groupBy(providerConnections.provider);
      for (const row of rows) counts.set(row.provider.slice(PROVIDER_PREFIX.length), Number(row.count));
      return counts;
    },
  };
  return service;
}

export type McpConnectorService = ReturnType<typeof createMcpConnectorService>;
