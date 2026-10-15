/**
 * Connectors: MCP servers an admin installs (管理 → 连接器), the built-in connectors Greenhouse
 * provides itself (the member's own mailbox, mailbox.ts), the connections members make to them
 * (设置 → 连接), and what an Agent may call through them (mcp_call).
 *
 * - Auth modes: `none`; `shared` (one key, sealed on the connector, sent in a header or a query
 *   parameter); `per_member` (each member's own key, checked against the server before it is
 *   kept); `oauth` (each member signs in, see oauth.ts).
 * - The tool list is cached on the connector: listed when it is installed or changed, on an
 *   admin's refresh, and with the first member connection when nobody could list it before. A
 *   failed listing keeps the last good list and records `last_error`.
 * - Agents see a tool when the connector is enabled, in the Agent's manifest (null: all), on
 *   the allowlist, and usable for the asker (their connection, for per_member and oauth). Tools
 *   declared read-only (or vouched, and not destructive) run at once; any other tool needs the
 *   member's approval and an Agent that may write.
 * - Keys, tokens and client secrets are sealed (secrets.ts) and never returned; errors pass
 *   through `redact` first. The network is network.ts: https, public addresses in production,
 *   deadlines.
 * - The built-in mailbox has the slug `mailbox` and no row in `connectors`: each member connects
 *   their own (a `connections` row of kind `email`, its password sealed, IMAP and SMTP both tested
 *   before it is kept), and the manifest's `connectors` scope it like any other.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type {
  AgentManifest,
  AvailableConnector,
  CatalogEntry,
  ConnectMailboxInput,
  Connection,
  ConnectionTest,
  Connector,
  ConnectorTest,
  ConnectorTool,
  MyConnections,
  OAuthStart,
  ProbeResult,
  RegistryResult,
  connectKeyInputSchema,
  createConnectorInputSchema,
  oauthFinishInputSchema,
  probeInputSchema,
  updateConnectorInputSchema,
} from '@greenhouse/contract';
import {
  connections,
  connectors,
  getDb,
  members,
  newId,
  transaction,
  type ConnectionRow,
  type ConnectorAuthMode,
  type ConnectorRow,
  type ConnectorToolSpec,
  type ConnectorTransport,
} from '@greenhouse/db';
import { isUniqueViolation, toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { audit, changedFields } from '../../audit.js';
import type { AppConfig } from '../../config/index.js';
import { ApiError, conflict, forbidden, invalidInput, notFound } from '../../http/errors.js';
import {
  catalogReader,
  OFFICIAL_REGISTRY_URL,
  probe,
  REGISTRY_TIMEOUT_MS,
  registrySearch,
  type CatalogItem,
} from './catalog.js';
import {
  callTool,
  describeError,
  explainFailedConnect,
  isAuthFailure,
  listTools,
  REQUEST_TIMEOUT_MS,
  type CallOutcome,
  type Target,
} from './mcp.js';
import { assertConnectorUrl, connectorFetch, serviceFetch, type NetworkMode } from './network.js';
import {
  beginSignIn,
  CALLBACK_PATH,
  ConnectorOAuthProvider,
  finishSignIn,
  manualClient,
  openState,
  readClient,
  revokeSignIn,
  SIGN_IN_TTL_MS,
  SignInError,
  withConnectionLock,
  type OAuthDeps,
} from './oauth.js';
import {
  MAILBOX_CONNECTOR_ID,
  MAILBOX_SLUG,
  MAILBOX_TOOLS,
  MailboxError,
  mailboxClient,
  runMailboxTool,
  type MailboxSettings,
} from './mailbox.js';
import { placeOf, redact, seal, unseal } from './secrets.js';
import { findConnection, markConnection, saveConnection, type KeySecrets } from './store.js';

type CreateInput = z.output<typeof createConnectorInputSchema>;
type UpdateInput = z.output<typeof updateConnectorInputSchema>;
type ConnectKeyInput = z.output<typeof connectKeyInputSchema>;
type FinishInput = z.output<typeof oauthFinishInputSchema>;
type ProbeInput = z.output<typeof probeInputSchema>;

/** A tool an Agent may call, `readOnly` as it counts here (declared, or vouched and not destructive). */
export interface UsableTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
}

/** A connector an Agent may use for this asker now. */
export interface UsableConnector {
  id: string;
  slug: string;
  name: string;
  description: string;
  tools: UsableTool[];
}

/** Headers the connection itself uses: a key never goes in one of these. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'accept',
  'accept-encoding',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

const personal = (mode: ConnectorAuthMode) => mode === 'per_member' || mode === 'oauth';

/** Runs at once: the server says it only reads, or an admin vouched for it and the server does not call it destructive. */
export function isReadOnly(
  tool: Pick<ConnectorToolSpec, 'name' | 'readOnly' | 'destructive'>,
  vouched: readonly string[],
) {
  return tool.readOnly || (!tool.destructive && vouched.includes(tool.name));
}

/** The tools Agents may call: the allowlist applied, read-only as it counts here. */
export function callableTools(row: Pick<ConnectorRow, 'tools' | 'allowedTools' | 'readOnlyTools'>): UsableTool[] {
  const allowed = row.allowedTools ? new Set(row.allowedTools) : null;
  return row.tools
    .filter((tool) => !allowed || allowed.has(tool.name))
    .map((tool) => ({ ...tool, readOnly: isReadOnly(tool, row.readOnlyTools) }));
}

/** Puts a key where the connector says: a query parameter, or a header (Authorization by default). */
export function placeKey(
  row: Pick<ConnectorRow, 'url' | 'authHeader' | 'authQueryParam' | 'authPrefix'>,
  secret: string,
): { url: string; headers: Record<string, string> } {
  const value = `${row.authPrefix ?? ''}${secret}`;
  if (row.authQueryParam) {
    const url = new URL(row.url);
    url.searchParams.set(row.authQueryParam, value);
    return { url: url.toString(), headers: {} };
  }
  return { url: row.url, headers: { [row.authHeader || 'Authorization']: value } };
}

/** The rule a whole configuration must meet; checked after an update is merged onto the row. */
export function authConfigProblem(config: {
  authMode: ConnectorAuthMode;
  authHeader: string | null;
  authQueryParam: string | null;
  sharedKeySet: boolean;
}): string | null {
  if (config.authHeader && config.authQueryParam) return 'Send the key in a header or in a query parameter, not both.';
  if (config.authHeader && RESERVED_HEADERS.has(config.authHeader.toLowerCase())) {
    return `The ${config.authHeader} header belongs to the connection itself; pick another.`;
  }
  const placed = Boolean(config.authHeader || config.authQueryParam);
  switch (config.authMode) {
    case 'none':
    case 'oauth':
      return config.sharedKeySet
        ? `A "${config.authMode}" connector sends no shared key: clear it or choose "shared".`
        : null;
    case 'shared':
      if (!config.sharedKeySet) return 'A "shared" connector needs the key every member will use.';
      return placed ? null : 'Say where the key goes: a header or a query parameter.';
    case 'per_member':
      if (config.sharedKeySet) return 'A "per_member" connector stores no shared key: clear it.';
      return placed ? null : "Say where each member's key goes: a header or a query parameter.";
  }
}

function toolView(row: ConnectorRow, tool: ConnectorToolSpec): ConnectorTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    declared_read_only: tool.readOnly,
    destructive: tool.destructive,
    allowed: !row.allowedTools || row.allowedTools.includes(tool.name),
    read_only: isReadOnly(tool, row.readOnlyTools),
  };
}

/** The built-in mailbox as the connector of a member's `email` connection. */
const MAILBOX_VIEW = { id: MAILBOX_CONNECTOR_ID, slug: MAILBOX_SLUG, name: 'Mailbox', enabled: true };

/** A mailbox connection's settings, without its password. */
function mailboxSettingsOf(row: Pick<ConnectionRow, 'config'>): MailboxSettings | null {
  const config = row.config as Partial<MailboxSettings>;
  if (!config.address || !config.imap || !config.smtp || !config.username) return null;
  return config as MailboxSettings;
}

function connectionView(
  row: ConnectionRow,
  connector: Pick<ConnectorRow, 'id' | 'slug' | 'name' | 'enabled'> | null,
): Connection {
  const mailbox = row.kind === 'email' ? mailboxSettingsOf(row) : null;
  return {
    id: row.id,
    kind: row.kind,
    connector: connector
      ? { id: connector.id, slug: connector.slug, name: connector.name, enabled: connector.enabled }
      : row.kind === 'email'
        ? MAILBOX_VIEW
        : null,
    mailbox: mailbox
      ? {
          address: mailbox.address,
          imap: { ...mailbox.imap },
          smtp: { ...mailbox.smtp },
          username: mailbox.username,
        }
      : null,
    display_name: row.displayName,
    status: row.status,
    last_error: row.lastError,
    last_verified_at: row.lastVerifiedAt,
    scopes: row.scopes,
    expires_at: row.expiresAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

type Resolved =
  | {
      ok: true;
      target: Target;
      secrets: string[];
      connection: ConnectionRow | null;
      provider: ConnectorOAuthProvider | null;
    }
  | { ok: false; reason: 'not_connected' | 'needs_reauth'; message: string };

type Listing = { ok: true; tools: ConnectorToolSpec[] } | { ok: false; error: string; missing?: boolean };

export function createConnectorsService(deps: {
  config: AppConfig;
  /** The built-in catalog; tests hand in their own entries. */
  catalog?: () => CatalogItem[];
  /** The MCP Registry; tests point it at a local server. */
  registryUrl?: string;
}) {
  const key = Buffer.from(deps.config.providerEncryptionKey, 'hex');
  const mode: NetworkMode = deps.config.NODE_ENV;
  const publicUrl = deps.config.PUBLIC_URL.replace(/\/+$/, '');
  const oauth: OAuthDeps = { key, mode, redirectUri: `${publicUrl}${CALLBACK_PATH}` };
  const catalogEntries = deps.catalog ?? catalogReader();
  const searchRegistry = registrySearch({
    baseUrl: deps.registryUrl ?? OFFICIAL_REGISTRY_URL,
    fetch: serviceFetch(mode, REGISTRY_TIMEOUT_MS),
    catalogIds: () => new Set(catalogEntries().map((entry) => entry.id)),
  });

  async function checkUrl(url: string) {
    try {
      await assertConnectorUrl(url, mode);
    } catch (error) {
      throw invalidInput(toErrorMessage(error));
    }
  }

  async function row(id: string): Promise<ConnectorRow> {
    const [found] = await getDb().select().from(connectors).where(eq(connectors.id, id));
    if (!found) throw notFound('Connector');
    return found;
  }

  async function enabledRow(id: string): Promise<ConnectorRow> {
    const found = await row(id);
    if (!found.enabled) throw conflict('connector_disabled', `${found.name} is turned off.`);
    return found;
  }

  /** Enabled connectors in a manifest's list (null: all), by slug. */
  /** Whether the manifest lets the Agent use the member's built-in mailbox (null: every connector). */
  const mailboxAllowed = (manifest: Pick<AgentManifest, 'connectors'>) =>
    !manifest.connectors || manifest.connectors.includes(MAILBOX_SLUG);

  async function enabledFor(manifest: Pick<AgentManifest, 'connectors'>): Promise<ConnectorRow[]> {
    const allowed = manifest.connectors ? new Set(manifest.connectors) : null;
    if (allowed && !allowed.size) return [];
    const rows = await getDb()
      .select()
      .from(connectors)
      .where(eq(connectors.enabled, true))
      .orderBy(asc(connectors.slug));
    return rows.filter((found) => !allowed || allowed.has(found.slug));
  }

  async function connectionCounts(ids?: string[]): Promise<Map<string, number>> {
    const rows = await getDb()
      .select({ id: connections.connectorId, n: sql<number>`count(*)::int` })
      .from(connections)
      .where(and(eq(connections.kind, 'connector'), ids ? inArray(connections.connectorId, ids) : undefined))
      .groupBy(connections.connectorId);
    return new Map(rows.map((entry) => [entry.id!, entry.n]));
  }

  function view(found: ConnectorRow, connectionCount: number): Connector {
    const client = readClient(key, found);
    return {
      id: found.id,
      slug: found.slug,
      name: found.name,
      description: found.description,
      url: found.url,
      transport: found.transport,
      auth_mode: found.authMode,
      auth_header: found.authHeader,
      auth_query_param: found.authQueryParam,
      auth_prefix: found.authPrefix,
      shared_key_set: Boolean(found.authEnc),
      key_help: found.keyHelp,
      key_help_url: found.keyHelpUrl,
      oauth_scope: found.oauthScope,
      oauth_client: client
        ? { source: client.source, client_id: client.client_id, secret_set: Boolean(client.client_secret) }
        : null,
      enabled: found.enabled,
      allowed_tools: found.allowedTools,
      read_only_tools: found.readOnlyTools,
      catalog_id: found.catalogId,
      tools: found.tools.map((tool) => toolView(found, tool)),
      tools_refreshed_at: found.toolsRefreshedAt,
      last_error: found.lastError,
      connection_count: connectionCount,
      created_at: found.createdAt,
      updated_at: found.updatedAt,
    };
  }

  const viewOf = async (found: ConnectorRow) => view(found, (await connectionCounts([found.id])).get(found.id) ?? 0);

  /** Who a call is made as: nobody, the shared key, the member's key, or the member's sign-in. */
  async function resolve(found: ConnectorRow, memberId: string): Promise<Resolved> {
    const fetchLike = connectorFetch(found.url, mode, REQUEST_TIMEOUT_MS);
    const plain = { url: found.url, transport: found.transport, headers: {}, fetch: fetchLike };
    if (found.authMode === 'none') return { ok: true, target: plain, secrets: [], connection: null, provider: null };
    if (found.authMode === 'shared') {
      const stored = unseal<KeySecrets>(key, placeOf.sharedKey(found.id), found.authEnc);
      if (!stored?.key)
        throw conflict(
          'connector_key_unreadable',
          `The key of ${found.name} cannot be read: an admin should enter it again.`,
        );
      return {
        ok: true,
        target: { ...plain, ...placeKey(found, stored.key) },
        secrets: [stored.key],
        connection: null,
        provider: null,
      };
    }
    const connection = await findConnection(memberId, found.id);
    const how = found.authMode === 'oauth' ? 'sign in to it' : 'add their own key for it';
    if (!connection) {
      return {
        ok: false,
        reason: 'not_connected',
        message: `${found.name} works with each member's own account, and this member has not connected it: they need to ${how} in 设置 → 连接.`,
      };
    }
    const expired = {
      ok: false as const,
      reason: 'needs_reauth' as const,
      message: `The member's connection to ${found.name} no longer works: they need to reconnect it in 设置 → 连接.`,
    };
    if (connection.status === 'needs_reauth' || !connection.secretsEnc) return expired;
    if (found.authMode === 'per_member') {
      const stored = unseal<KeySecrets>(key, placeOf.connection(connection.id), connection.secretsEnc);
      if (!stored?.key) return expired;
      return {
        ok: true,
        target: { ...plain, ...placeKey(found, stored.key) },
        secrets: [stored.key],
        connection,
        provider: null,
      };
    }
    const provider = new ConnectorOAuthProvider(oauth, found, memberId, 'call');
    return { ok: true, target: { ...plain, authProvider: provider }, secrets: [], connection, provider };
  }

  /** Every secret a call carried: the key, or the tokens of the sign-in (refreshed ones too). */
  const secretsOf = (resolved: Resolved & { ok: true }) => [
    ...resolved.secrets,
    ...(resolved.provider?.secrets() ?? []),
  ];

  /** Runs work as the member: one request at a time per sign-in, so a refresh is never spent twice. */
  function asMember<T>(
    found: ConnectorRow,
    memberId: string,
    resolved: Resolved & { ok: true },
    work: () => Promise<T>,
  ) {
    return resolved.provider ? withConnectionLock(found.id, memberId, work) : work();
  }

  /** A credential the server refused: the member's key or sign-in must be renewed. */
  async function refused(resolved: Resolved & { ok: true }, message: string) {
    if (resolved.provider) await resolved.provider.expireUsedSignIn(message);
    else if (resolved.connection) {
      await markConnection(
        resolved.connection.id,
        { status: 'needs_reauth', error: message },
        resolved.connection.secretsEnc,
      );
    }
  }

  /** Lists the server's tools as the member. A refused member credential is marked to renew. */
  async function listAs(found: ConnectorRow, memberId: string): Promise<Listing> {
    const resolved = await resolve(found, memberId);
    if (!resolved.ok) return { ok: false, error: resolved.message, missing: true };
    try {
      return { ok: true, tools: await asMember(found, memberId, resolved, () => listTools(resolved.target)) };
    } catch (error) {
      const better = resolved.provider ? null : await explainFailedConnect(resolved.target);
      const message = redact(better ?? describeError(error), secretsOf(resolved));
      if (personal(found.authMode) && isAuthFailure(error)) await refused(resolved, message);
      return { ok: false, error: message };
    }
  }

  /** Records a listing on the connector: a failure keeps the last good tools. */
  async function record(found: ConnectorRow, listing: Listing): Promise<ConnectorRow> {
    if (!listing.ok && listing.missing) return found;
    const [updated] = await getDb()
      .update(connectors)
      .set(
        listing.ok
          ? { tools: listing.tools, toolsRefreshedAt: new Date().toISOString(), lastError: null, updatedAt: sql`now()` }
          : { lastError: listing.error, updatedAt: sql`now()` },
      )
      .where(eq(connectors.id, found.id))
      .returning();
    return updated ?? found;
  }

  /** The first member to connect lists the tools of a connector nobody could list before. */
  async function listIfEmpty(found: ConnectorRow, memberId: string, tools?: ConnectorToolSpec[]) {
    if (found.tools.length) return;
    const listing: Listing = tools ? { ok: true, tools } : await listAs(found, memberId);
    if (listing.ok) await record(found, listing);
    else
      logger.info('[connectors] listing after a first connection failed', {
        connector: found.slug,
        error: listing.error,
      });
  }

  async function localeOf(memberId: string): Promise<'zh' | 'en'> {
    const [member] = await getDb().select({ locale: members.locale }).from(members).where(eq(members.id, memberId));
    return member?.locale.startsWith('en') ? 'en' : 'zh';
  }

  /** The settings of a new connector: from a catalog entry, or as typed. */
  async function settingsFor(actorId: string, input: CreateInput) {
    if ('catalog_id' in input) {
      const entry = catalogEntries().find((candidate) => candidate.id === input.catalog_id);
      if (!entry) throw notFound('Catalog entry');
      const zh = (await localeOf(actorId)) === 'zh';
      return {
        slug: input.slug ?? entry.slug,
        name: entry.title,
        description: entry.description,
        url: entry.url,
        transport: entry.transport as ConnectorTransport,
        authMode: entry.auth.mode as ConnectorAuthMode,
        authHeader: entry.auth.header,
        authQueryParam: entry.auth.query_param,
        authPrefix: entry.auth.prefix,
        sharedKey: null as string | null,
        // Members read the help in the language of the admin who installed it.
        keyHelp: (zh ? entry.auth.help_zh : entry.auth.help) ?? entry.auth.help ?? '',
        keyHelpUrl: entry.auth.help_url,
        oauthScope: entry.auth.scope,
        oauthClientId: null as string | null,
        oauthClientSecret: null as string | null,
        allowedTools: null as string[] | null,
        readOnlyTools: entry.read_only_tools,
        enabled: true,
        catalogId: entry.id,
      };
    }
    return {
      slug: input.slug,
      name: input.name,
      description: input.description ?? '',
      url: input.url,
      transport: input.transport ?? 'streamable_http',
      authMode: input.auth_mode ?? (input.shared_key ? 'shared' : 'none'),
      authHeader: input.auth_header ?? null,
      authQueryParam: input.auth_query_param ?? null,
      authPrefix: input.auth_prefix ?? null,
      sharedKey: input.shared_key || null,
      keyHelp: input.key_help ?? '',
      keyHelpUrl: input.key_help_url ?? null,
      oauthScope: input.oauth_scope ?? null,
      oauthClientId: input.oauth_client_id ?? null,
      oauthClientSecret: input.oauth_client_secret || null,
      allowedTools: input.allowed_tools ?? null,
      readOnlyTools: input.read_only_tools ?? [],
      enabled: input.enabled ?? true,
      catalogId: null as string | null,
    };
  }

  /** A key goes in a header (Authorization unless said otherwise) or a query parameter; none and oauth send none. */
  function placement(authMode: ConnectorAuthMode, header: string | null, param: string | null, prefix: string | null) {
    if (!(authMode === 'shared' || authMode === 'per_member')) {
      return { authHeader: null, authQueryParam: null, authPrefix: null };
    }
    return { authHeader: header ?? (param ? null : 'Authorization'), authQueryParam: param, authPrefix: prefix };
  }

  function checkHelpUrl(url: string | null) {
    if (url && !url.startsWith('https://')) throw invalidInput('The help link must be an https:// address.');
  }

  async function connectionViewOf(found: ConnectionRow): Promise<Connection> {
    const [owner] = found.connectorId
      ? await getDb()
          .select({ id: connectors.id, slug: connectors.slug, name: connectors.name, enabled: connectors.enabled })
          .from(connectors)
          .where(eq(connectors.id, found.connectorId))
      : [];
    return connectionView(found, owner ?? null);
  }

  /** A member's own connection changed: who and which connector, never a key or a token. */
  const connectionAudit = (memberId: string, action: string, id: string, summary: string) => ({
    actorId: memberId,
    action,
    resourceType: 'connection',
    resourceId: id,
    summary,
  });

  /** The member's mailbox connection (the built-in connector), if any. */
  async function mailboxConnection(memberId: string): Promise<ConnectionRow | null> {
    const [found] = await getDb()
      .select()
      .from(connections)
      .where(and(eq(connections.memberId, memberId), eq(connections.kind, 'email')));
    return found ?? null;
  }

  /** A client for the member's own mailbox, with its sealed password opened. */
  function mailboxOf(connection: ConnectionRow) {
    const settings = mailboxSettingsOf(connection);
    const stored = unseal<{ password: string }>(key, placeOf.connection(connection.id), connection.secretsEnc);
    if (!settings || !stored?.password) return null;
    return mailboxClient(settings, stored.password, mode);
  }

  async function ownConnection(memberId: string, id: string): Promise<ConnectionRow> {
    const [found] = await getDb()
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.memberId, memberId)));
    if (!found) throw notFound('Connection');
    return found;
  }

  /** One tool of the member's own mailbox; a refused password marks the connection to renew. */
  async function runMailbox(memberId: string, toolName: string, args: Record<string, unknown>): Promise<CallOutcome> {
    const connection = await mailboxConnection(memberId);
    const client = connection && connection.status !== 'needs_reauth' ? mailboxOf(connection) : null;
    if (!connection || !client) {
      throw new Error("The member's mailbox is not connected: they need to connect it in 设置 → 连接.");
    }
    const started = Date.now();
    try {
      const outcome = await runMailboxTool(client, toolName, args);
      logger.info('[connectors] a mailbox tool ran', {
        tool: toolName,
        durationMs: Date.now() - started,
        member: memberId,
      });
      return outcome;
    } catch (error) {
      if (error instanceof MailboxError && error.authFailed) {
        await markConnection(connection.id, { status: 'needs_reauth', error: error.message }, connection.secretsEnc);
        throw new Error("The mailbox refused the member's password: they need to reconnect it in 设置 → 连接.");
      }
      logger.warn('[connectors] a mailbox tool failed', { tool: toolName, error: toErrorMessage(error) });
      throw new Error(`Using the mailbox failed: ${toErrorMessage(error)}`);
    }
  }

  const service = {
    // ─── admin ───────────────────────────────────────────

    async list(): Promise<{ items: Connector[] }> {
      const rows = await getDb().select().from(connectors).orderBy(asc(connectors.slug));
      const counts = await connectionCounts();
      return { items: rows.map((found) => view(found, counts.get(found.id) ?? 0)) };
    },

    async get(id: string): Promise<Connector> {
      return viewOf(await row(id));
    },

    async catalog(): Promise<{ items: CatalogEntry[] }> {
      const installed = new Map(
        (await getDb().select({ catalogId: connectors.catalogId, slug: connectors.slug }).from(connectors))
          .filter((entry) => entry.catalogId)
          .map((entry) => [entry.catalogId!, entry.slug]),
      );
      return {
        items: catalogEntries().map((entry) => ({ ...entry, installed_slug: installed.get(entry.id) ?? null })),
      };
    },

    async registry(query: string): Promise<{ items: RegistryResult[] }> {
      try {
        return { items: await searchRegistry(query) };
      } catch (error) {
        throw new ApiError(502, 'registry_unavailable', toErrorMessage(error));
      }
    },

    async probe(input: ProbeInput): Promise<ProbeResult> {
      await checkUrl(input.url);
      return probe(input.url, input.transport, mode);
    },

    /** Installs a connector and lists its tools right away; a server that cannot be reached is still saved. */
    async create(actorId: string, input: CreateInput): Promise<Connector> {
      const settings = await settingsFor(actorId, input);
      if (settings.slug === MAILBOX_SLUG) {
        throw conflict('connector_slug_taken', `"${MAILBOX_SLUG}" is a built-in connector; pick another slug.`);
      }
      await checkUrl(settings.url);
      checkHelpUrl(settings.keyHelpUrl);
      const placed = placement(settings.authMode, settings.authHeader, settings.authQueryParam, settings.authPrefix);
      const problem = authConfigProblem({ authMode: settings.authMode, ...placed, sharedKeySet: !!settings.sharedKey });
      if (problem) throw invalidInput(problem);
      if (settings.oauthClientId && settings.authMode !== 'oauth') {
        throw invalidInput('An OAuth client belongs to an "oauth" connector.');
      }
      const id = newId('connector');
      let created: ConnectorRow;
      try {
        created = await transaction(async (db) => {
          const [inserted] = await db
            .insert(connectors)
            .values({
              id,
              slug: settings.slug,
              name: settings.name,
              description: settings.description,
              url: settings.url,
              transport: settings.transport,
              authMode: settings.authMode,
              ...placed,
              authEnc: settings.sharedKey ? seal(key, placeOf.sharedKey(id), { key: settings.sharedKey }) : null,
              keyHelp: settings.keyHelp,
              keyHelpUrl: settings.keyHelpUrl,
              oauthScope: settings.oauthScope,
              oauthClientEnc: settings.oauthClientId
                ? manualClient(key, id, settings.oauthClientId, settings.oauthClientSecret ?? undefined)
                : null,
              allowedTools: settings.allowedTools,
              readOnlyTools: settings.readOnlyTools,
              catalogId: settings.catalogId,
              enabled: settings.enabled,
              createdBy: actorId,
            })
            .returning();
          await audit({
            actorId,
            action: 'connector.create',
            resourceType: 'connector',
            resourceId: id,
            summary: `${settings.slug} ${settings.authMode}${settings.catalogId ? ` from catalog ${settings.catalogId}` : ''}`,
          });
          return inserted!;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict(
            'connector_slug_taken',
            `A connector called "${settings.slug}" already exists; pick another slug.`,
          );
        }
        throw error;
      }
      if (created.enabled) created = await record(created, await listAs(created, actorId));
      return viewOf(created);
    },

    /**
     * Edits a connector. A new address or auth mode disconnects every member (their connections
     * were made for the old one); anything that changes how calls authenticate lists the tools again.
     */
    async update(actorId: string, id: string, input: UpdateInput): Promise<Connector> {
      if (input.url !== undefined) await checkUrl(input.url);
      if (input.key_help_url !== undefined) checkHelpUrl(input.key_help_url);
      const { updated, relist } = await transaction(async (db) => {
        const [current] = await db.select().from(connectors).where(eq(connectors.id, id)).for('update');
        if (!current) throw notFound('Connector');
        const authMode = input.auth_mode ?? current.authMode;
        const moved = input.url !== undefined && input.url !== current.url;
        const modeChanged = authMode !== current.authMode;
        // A shared key belongs to "shared": choosing another mode drops it.
        const sharedKey =
          input.shared_key !== undefined
            ? input.shared_key || null
            : authMode === 'shared'
              ? (unseal<KeySecrets>(key, placeOf.sharedKey(id), current.authEnc)?.key ?? null)
              : null;
        const placed = placement(
          authMode,
          input.auth_header !== undefined ? input.auth_header : current.authHeader,
          input.auth_query_param !== undefined ? input.auth_query_param : current.authQueryParam,
          input.auth_prefix !== undefined ? input.auth_prefix : current.authPrefix,
        );
        const problem = authConfigProblem({ authMode, ...placed, sharedKeySet: !!sharedKey });
        if (problem) throw invalidInput(problem);

        // The OAuth client: an admin's one is replaced or cleared by hand (its secret kept when the
        // same client is saved again without one); one this workspace registered goes with the address.
        const stored = readClient(key, current);
        let oauthClientEnc = current.oauthClientEnc;
        if (input.oauth_client_id !== undefined) {
          if (input.oauth_client_id === null) oauthClientEnc = stored?.source === 'manual' ? null : oauthClientEnc;
          else {
            const secret =
              input.oauth_client_secret !== undefined
                ? input.oauth_client_secret || undefined
                : stored?.source === 'manual' && stored.client_id === input.oauth_client_id
                  ? stored.client_secret
                  : undefined;
            oauthClientEnc = manualClient(key, id, input.oauth_client_id, secret);
          }
        } else if (input.oauth_client_secret !== undefined && stored?.source === 'manual') {
          oauthClientEnc = manualClient(key, id, stored.client_id, input.oauth_client_secret || undefined);
        }
        if (moved && readClient(key, { id, oauthClientEnc })?.source === 'dynamic') oauthClientEnc = null;
        if (authMode !== 'oauth') oauthClientEnc = null;

        const [saved] = await db
          .update(connectors)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.url !== undefined ? { url: input.url } : {}),
            ...(input.transport !== undefined ? { transport: input.transport } : {}),
            authMode,
            ...placed,
            authEnc: sharedKey ? seal(key, placeOf.sharedKey(id), { key: sharedKey }) : null,
            ...(input.key_help !== undefined ? { keyHelp: input.key_help } : {}),
            ...(input.key_help_url !== undefined ? { keyHelpUrl: input.key_help_url } : {}),
            ...(input.oauth_scope !== undefined ? { oauthScope: input.oauth_scope } : {}),
            oauthClientEnc,
            ...(moved || modeChanged ? { oauthDiscovery: null } : {}),
            // What the old address offered says nothing about the new one.
            ...(moved ? { tools: [], toolsRefreshedAt: null, lastError: null } : {}),
            ...(input.allowed_tools !== undefined ? { allowedTools: input.allowed_tools } : {}),
            ...(input.read_only_tools !== undefined ? { readOnlyTools: input.read_only_tools } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(connectors.id, id))
          .returning();
        if (moved || modeChanged) {
          await db.delete(connections).where(and(eq(connections.connectorId, id), eq(connections.kind, 'connector')));
        }
        const toggled = input.enabled !== undefined && input.enabled !== current.enabled;
        await audit({
          actorId,
          action: toggled ? (input.enabled ? 'connector.enable' : 'connector.disable') : 'connector.update',
          resourceType: 'connector',
          resourceId: id,
          // Field names only: never a key or a secret.
          summary: changedFields(input) + (moved || modeChanged ? '; members disconnected' : ''),
        });
        const relist =
          moved ||
          modeChanged ||
          (input.transport !== undefined && input.transport !== current.transport) ||
          input.shared_key !== undefined ||
          placed.authHeader !== current.authHeader ||
          placed.authQueryParam !== current.authQueryParam ||
          placed.authPrefix !== current.authPrefix;
        return { updated: saved!, relist };
      });
      const after = relist && updated.enabled ? await record(updated, await listAs(updated, actorId)) : updated;
      return viewOf(after);
    },

    async remove(actorId: string, id: string): Promise<void> {
      await transaction(async (db) => {
        const [deleted] = await db.delete(connectors).where(eq(connectors.id, id)).returning({ slug: connectors.slug });
        if (!deleted) throw notFound('Connector');
        await audit({
          actorId,
          action: 'connector.delete',
          resourceType: 'connector',
          resourceId: id,
          summary: deleted.slug,
        });
      });
    },

    /** Lists the tools again. A per_member or oauth connector is listed with the admin's own connection. */
    async refresh(actorId: string, id: string): Promise<Connector> {
      const found = await row(id);
      const listing = await listAs(found, actorId);
      if (!listing.ok && listing.missing) {
        throw conflict(
          'connection_required',
          `${found.name} lists its tools for each member's own account: connect yours in 设置 → 连接 first.`,
        );
      }
      const updated = await transaction(async () => {
        const saved = await record(found, listing);
        await audit({
          actorId,
          action: 'connector.refresh',
          resourceType: 'connector',
          resourceId: id,
          summary: listing.ok ? `${listing.tools.length} tools` : 'failed',
        });
        return saved;
      });
      return viewOf(updated);
    },

    /** Connects and lists the tools without changing the cached list; records whether it worked. */
    async test(actorId: string, id: string): Promise<ConnectorTest> {
      const found = await row(id);
      const started = Date.now();
      const listing = await listAs(found, actorId);
      if (!listing.ok && listing.missing) {
        throw conflict('connection_required', `Connect your own account to ${found.name} in 设置 → 连接 first.`);
      }
      await getDb()
        .update(connectors)
        .set({ lastError: listing.ok ? null : listing.error, updatedAt: sql`now()` })
        .where(eq(connectors.id, id));
      return {
        ok: listing.ok,
        latency_ms: Date.now() - started,
        tool_count: listing.ok ? listing.tools.length : null,
        error: listing.ok ? null : listing.error,
      };
    },

    // ─── members ─────────────────────────────────────────

    async mine(memberId: string): Promise<MyConnections> {
      const own = await getDb()
        .select({ connection: connections, connector: connectors })
        .from(connections)
        .leftJoin(connectors, eq(connectors.id, connections.connectorId))
        .where(eq(connections.memberId, memberId))
        .orderBy(asc(connections.id));
      const enabled = await getDb()
        .select()
        .from(connectors)
        .where(eq(connectors.enabled, true))
        .orderBy(asc(connectors.slug));
      const available: AvailableConnector[] = enabled.map((found) => {
        const tools = callableTools(found);
        return {
          id: found.id,
          slug: found.slug,
          name: found.name,
          description: found.description,
          auth_mode: found.authMode,
          needs_connection: personal(found.authMode),
          key_help: found.keyHelp,
          key_help_url: found.keyHelpUrl,
          tool_count: tools.length,
          read_only_tool_count: tools.filter((tool) => tool.readOnly).length,
          builtin: null,
        };
      });
      const mailboxTools = MAILBOX_TOOLS;
      available.push({
        id: MAILBOX_CONNECTOR_ID,
        slug: MAILBOX_SLUG,
        name: MAILBOX_VIEW.name,
        description:
          'Your own mailbox over IMAP and SMTP: your Agents search and read it; drafts and sending wait for your approval.',
        auth_mode: 'per_member',
        needs_connection: true,
        key_help: '',
        key_help_url: null,
        tool_count: mailboxTools.length,
        read_only_tool_count: mailboxTools.filter((tool) => tool.readOnly).length,
        builtin: 'mailbox',
      });
      return {
        items: own.map((entry) => connectionView(entry.connection, entry.connector)),
        connectors: available,
      };
    },

    /**
     * Connects the member's own mailbox: IMAP and SMTP are both tried with these settings first
     * (a private address is refused), and only then is anything kept, the password sealed.
     */
    async connectMailbox(memberId: string, input: ConnectMailboxInput): Promise<Connection> {
      const settings: MailboxSettings = {
        address: input.address,
        ...(input.display_name ? { displayName: input.display_name } : {}),
        imap: { host: input.imap.host, port: input.imap.port, security: input.imap.security },
        smtp: { host: input.smtp.host, port: input.smtp.port, security: input.smtp.security },
        username: input.username ?? input.address,
      };
      const checked = await mailboxClient(settings, input.password, mode).test();
      if (checked.imap || checked.smtp) {
        throw new ApiError(400, 'mailbox_rejected', 'The mailbox could not be reached with these settings.', {
          imap: checked.imap,
          smtp: checked.smtp,
        });
      }
      const saved = await transaction(async (db) => {
        const [existing] = await db
          .select({ id: connections.id })
          .from(connections)
          .where(and(eq(connections.memberId, memberId), eq(connections.kind, 'email')))
          .for('update');
        const id = existing?.id ?? newId('connection');
        const values = {
          externalId: settings.address,
          displayName: settings.displayName ?? settings.address,
          config: settings as unknown as Record<string, unknown>,
          secretsEnc: seal(key, placeOf.connection(id), { password: input.password }),
          status: 'active' as const,
          lastError: null,
          lastVerifiedAt: new Date().toISOString(),
        };
        const [row] = existing
          ? await db
              .update(connections)
              .set({ ...values, updatedAt: sql`now()` })
              .where(eq(connections.id, id))
              .returning()
          : await db
              .insert(connections)
              .values({ id, memberId, kind: 'email', ...values })
              .returning();
        await audit(connectionAudit(memberId, existing ? 'connection.update' : 'connection.create', id, 'mailbox'));
        return row!;
      });
      return connectionView(saved, null);
    },

    /** Keeps the member's own key, once the server accepted it. */
    async connectKey(memberId: string, input: ConnectKeyInput): Promise<Connection> {
      const found = await enabledRow(input.connector_id);
      if (found.authMode !== 'per_member') {
        throw conflict('wrong_auth_mode', `${found.name} does not take a personal key.`);
      }
      const target: Target = {
        ...placeKey(found, input.key),
        transport: found.transport,
        fetch: connectorFetch(found.url, mode, REQUEST_TIMEOUT_MS),
      };
      let tools: ConnectorToolSpec[];
      try {
        tools = await listTools(target);
      } catch (error) {
        const reason = redact((await explainFailedConnect(target)) ?? describeError(error), [input.key]);
        throw new ApiError(400, 'key_rejected', `${found.name} did not accept this key.`, { reason });
      }
      const saved = await transaction(async () => {
        const created = await saveConnection(key, memberId, found.id, { key: input.key });
        await audit(connectionAudit(memberId, 'connection.create', created.id, `${found.slug} key`));
        return created;
      });
      await listIfEmpty(found, memberId, tools);
      return connectionView(saved, found);
    },

    /** The address of the provider's consent page for this member. */
    async startOAuth(memberId: string, connectorId: string): Promise<OAuthStart> {
      const found = await enabledRow(connectorId);
      if (found.authMode !== 'oauth') throw conflict('wrong_auth_mode', `${found.name} does not use a sign-in.`);
      try {
        const url = await beginSignIn(oauth, found, memberId);
        return { authorization_url: url, expires_at: new Date(Date.now() + SIGN_IN_TTL_MS).toISOString() };
      } catch (error) {
        if (error instanceof SignInError) throw new ApiError(502, 'sign_in_failed', error.message);
        throw error;
      }
    },

    /** Finishes a sign-in that this same member started; anyone else's browser cannot. */
    async finishOAuth(memberId: string, input: FinishInput): Promise<Connection> {
      const state = openState(key, input.state);
      if (!state) throw new ApiError(400, 'sign_in_expired', 'This sign-in is invalid or expired: start again.');
      if (state.m !== memberId) {
        throw new ApiError(
          403,
          'sign_in_not_yours',
          'Someone else started this sign-in: start your own from 设置 → 连接.',
        );
      }
      const found = await enabledRow(state.c);
      if (found.authMode !== 'oauth') throw conflict('wrong_auth_mode', `${found.name} no longer uses a sign-in.`);
      try {
        await finishSignIn(oauth, found, state, input.code);
      } catch (error) {
        if (error instanceof SignInError) throw new ApiError(400, 'sign_in_failed', error.message);
        throw error;
      }
      const saved = await findConnection(memberId, found.id);
      if (!saved) throw new ApiError(500, 'internal', 'The sign-in was not stored.');
      await audit(connectionAudit(memberId, 'connection.create', saved.id, `${found.slug} oauth`));
      await listIfEmpty(await row(found.id), memberId);
      logger.info('[connectors] a member signed in', { connector: found.slug, member: memberId });
      return connectionView((await findConnection(memberId, found.id)) ?? saved, found);
    },

    /** Lists the tools with the member's connection and records how it went. */
    async testConnection(memberId: string, id: string): Promise<ConnectionTest> {
      const own = await ownConnection(memberId, id);
      if (own.kind === 'email') {
        const client = mailboxOf(own);
        const checked = client
          ? await client.test()
          : { imap: 'The stored settings cannot be read.', smtp: null, authFailed: true };
        const error = [checked.imap, checked.smtp].filter(Boolean).join(' · ') || null;
        await markConnection(
          own.id,
          error ? { status: checked.authFailed ? 'needs_reauth' : 'error', error } : { status: 'active' },
          own.secretsEnc,
        );
        return {
          ok: !error,
          tool_count: error ? null : MAILBOX_TOOLS.length,
          error,
          connection: connectionView(await ownConnection(memberId, id), null),
        };
      }
      if (own.kind !== 'connector' || !own.connectorId)
        throw conflict('not_testable', 'Only a connector connection can be tested here.');
      const found = await enabledRow(own.connectorId);
      const listing = await listAs(found, memberId);
      const latest = (await findConnection(memberId, found.id)) ?? own;
      if (listing.ok) {
        await markConnection(latest.id, { status: 'active' });
        await listIfEmpty(found, memberId, listing.tools);
      } else if (latest.status !== 'needs_reauth') {
        await markConnection(latest.id, { status: 'error', error: listing.error });
      }
      return {
        ok: listing.ok,
        tool_count: listing.ok ? listing.tools.length : null,
        error: listing.ok ? null : listing.error,
        connection: await connectionViewOf(await ownConnection(memberId, id)),
      };
    },

    /** Removes the member's connection; a sign-in is also revoked at the provider, best effort. */
    async disconnect(memberId: string, id: string): Promise<void> {
      const own = await ownConnection(memberId, id);
      if (own.connectorId) {
        const [found] = await getDb().select().from(connectors).where(eq(connectors.id, own.connectorId));
        if (found?.authMode === 'oauth') await revokeSignIn(oauth, found, own);
      }
      await transaction(async (db) => {
        await db.delete(connections).where(and(eq(connections.id, id), eq(connections.memberId, memberId)));
        await audit(connectionAudit(memberId, 'connection.delete', id, own.kind));
      });
    },

    /**
     * Where the public callback sends the browser: the web app's 设置 → 连接, carrying the code
     * and the state for the member's own session to finish, or the reason it failed.
     */
    callbackRedirect(query: { code?: string; state?: string; error?: string; error_description?: string }): string {
      const state = openState(key, query.state);
      const params = new URLSearchParams();
      if (state) params.set('connector', state.c);
      if (query.error) {
        params.set('oauth_error', query.error.slice(0, 100));
        if (query.error_description) params.set('oauth_error_description', query.error_description.slice(0, 300));
      } else if (!state) {
        params.set('oauth_error', 'invalid_state');
      } else if (!query.code) {
        params.set('oauth_error', 'missing_code');
      } else {
        params.set('oauth_state', query.state!);
        params.set('oauth_code', query.code.slice(0, 4096));
      }
      return `${publicUrl}/#/settings/connections?${params.toString()}`;
    },

    // ─── agents ──────────────────────────────────────────

    /**
     * Whether an Agent with this manifest has connectors at all: the built-in mailbox, which
     * every member can connect and whose reading tools need no write, or an enabled one in its
     * manifest (null: all) with a tool it may call, or whose tools nobody has listed yet, whether
     * or not the member connected it. This decides whether `mcp_call` is offered, so connecting
     * an account never changes a turn's tools.
     */
    async offered(manifest: Pick<AgentManifest, 'connectors' | 'write'>): Promise<boolean> {
      if (mailboxAllowed(manifest)) return true;
      return (await enabledFor(manifest)).some(
        (found) => !found.tools.length || callableTools(found).some((tool) => manifest.write || tool.readOnly),
      );
    },

    /**
     * What an Agent of this member may use now: enabled connectors in its manifest (null: all),
     * usable for the asker, with the tools it may call. An Agent that may not write sees only
     * the read-only tools.
     */
    async usable(memberId: string, manifest: Pick<AgentManifest, 'connectors' | 'write'>): Promise<UsableConnector[]> {
      // The member's own mailbox, once connected and while it works.
      const builtin: UsableConnector[] = [];
      if (mailboxAllowed(manifest)) {
        const mailbox = await mailboxConnection(memberId);
        if (mailbox && mailbox.status !== 'needs_reauth' && mailbox.secretsEnc) {
          const address = mailboxSettingsOf(mailbox)?.address ?? '';
          const tools = MAILBOX_TOOLS.filter((tool) => manifest.write || tool.readOnly);
          builtin.push({
            id: MAILBOX_CONNECTOR_ID,
            slug: MAILBOX_SLUG,
            name: `Mailbox ${address}`.trim(),
            description: "The member's own mailbox (IMAP and SMTP).",
            tools: tools.map((tool) => ({ ...tool })),
          });
        }
      }
      const candidates = await enabledFor(manifest);
      if (!candidates.length) return builtin;
      const mine = candidates.some((found) => personal(found.authMode))
        ? await getDb()
            .select({
              connectorId: connections.connectorId,
              status: connections.status,
              sealed: connections.secretsEnc,
            })
            .from(connections)
            .where(and(eq(connections.memberId, memberId), eq(connections.kind, 'connector')))
        : [];
      const usableNow = new Set(
        mine.filter((entry) => entry.status !== 'needs_reauth' && entry.sealed).map((entry) => entry.connectorId),
      );
      return [
        ...builtin,
        ...candidates.flatMap((found) => {
          if (personal(found.authMode) && !usableNow.has(found.id)) return [];
          const tools = callableTools(found).filter((tool) => manifest.write || tool.readOnly);
          return tools.length
            ? [{ id: found.id, slug: found.slug, name: found.name, description: found.description, tools }]
            : [];
        }),
      ];
    },

    /** One tool an Agent may call, or the sentence that tells the model why not. */
    async findTool(
      memberId: string,
      manifest: Pick<AgentManifest, 'connectors' | 'write'>,
      slug: string,
      toolName: string,
    ): Promise<{ connector: UsableConnector; tool: UsableTool } | { error: string }> {
      const usable = await service.usable(memberId, manifest);
      const connector = usable.find((entry) => entry.slug === slug);
      if (!connector) {
        const names = usable.map((entry) => `"${entry.slug}"`).join(', ');
        return { error: `There is no connector "${slug}" you can use here. You can use: ${names || 'none'}.` };
      }
      const tool = connector.tools.find((entry) => entry.name === toolName);
      if (!tool) {
        const names = connector.tools.map((entry) => `"${entry.name}"`).join(', ');
        return { error: `"${slug}" has no tool "${toolName}" you can use here. Its tools: ${names}.` };
      }
      return { connector, tool };
    },

    /**
     * Runs one tool as the member, with their key or sign-in. Throws with a sentence the model can
     * pass on; a credential the server refused is marked for the member to renew.
     */
    async run(
      memberId: string,
      connectorId: string,
      toolName: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<CallOutcome> {
      if (connectorId === MAILBOX_CONNECTOR_ID) return runMailbox(memberId, toolName, args);
      const found = await row(connectorId);
      if (!found.enabled) throw new Error(`${found.name} was turned off.`);
      const resolved = await resolve(found, memberId);
      if (!resolved.ok) throw new Error(resolved.message);
      const started = Date.now();
      try {
        const outcome = await asMember(found, memberId, resolved, () =>
          callTool(resolved.target, toolName, args, signal),
        );
        logger.info('[connectors] a tool ran', {
          connector: found.slug,
          tool: toolName,
          isError: outcome.isError,
          durationMs: Date.now() - started,
          member: memberId,
        });
        return {
          isError: outcome.isError,
          text: redact(outcome.text, secretsOf(resolved)),
          ...(outcome.data !== undefined
            ? { data: JSON.parse(redact(JSON.stringify(outcome.data), secretsOf(resolved))) }
            : {}),
        };
      } catch (error) {
        const reason = redact(describeError(error), secretsOf(resolved));
        if (personal(found.authMode) && isAuthFailure(error)) {
          await refused(resolved, reason);
          throw new Error(
            `${found.name} refused the member's ${found.authMode === 'oauth' ? 'sign-in' : 'key'}: they need to reconnect it in 设置 → 连接.`,
          );
        }
        logger.warn('[connectors] a tool failed', { connector: found.slug, tool: toolName, error: reason });
        throw new Error(`Calling ${toolName} on ${found.name} failed: ${reason}`);
      }
    },
  };
  const cardCache = new Map<string, { until: number; result: CallOutcome }>();
  return {
    ...service,
    async readCard(memberId: string, slug: string, toolName: string, args: Record<string, unknown>) {
      const found = await service.findTool(memberId, { connectors: null, write: false }, slug, toolName);
      if (!('tool' in found) || !found.tool.readOnly)
        throw forbidden('This card requires an available read-only connector tool.');
      // Re-read the connection and connector revisions even on a cache hit: disconnects apply at once.
      const [connector] = await getDb().select().from(connectors).where(eq(connectors.id, found.connector.id));
      if (!connector || !personal(connector.authMode))
        throw forbidden('External cards require the viewer’s own connection.');
      const connection = await findConnection(memberId, connector.id);
      if (!connection || connection.status === 'needs_reauth')
        throw forbidden('Connect your account before opening this card.');
      const cacheKey = JSON.stringify([
        memberId,
        connection.id,
        connection.updatedAt,
        connector.updatedAt,
        toolName,
        args,
      ]);
      const cached = cardCache.get(cacheKey);
      if (cached && cached.until > Date.now()) return cached.result;
      const result = await service.run(memberId, found.connector.id, toolName, args, AbortSignal.timeout(15_000));
      if (result.isError) throw new ApiError(502, 'external_data_failed', 'The connector could not read this card.');
      if (Buffer.byteLength(JSON.stringify(result)) > 256_000)
        throw invalidInput('External card data is at most 256 KB.');
      for (const [key, entry] of cardCache) if (entry.until <= Date.now()) cardCache.delete(key);
      if (cardCache.size >= 500) cardCache.delete(cardCache.keys().next().value!);
      cardCache.set(cacheKey, { until: Date.now() + 15_000, result });
      return result;
    },
  };
}

export type ConnectorsService = ReturnType<typeof createConnectorsService>;
