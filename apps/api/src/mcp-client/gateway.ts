/** Shared connector gateway: identity, live policy, credentials, consent and redaction. */
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { DatabaseProvider, McpServerRow } from '@greenhouse/db';
import { isPersonalAuthMode, type McpConnectionStatus, type McpNeedsConnection } from '@greenhouse/types/mcp-servers';
import { logger } from '@greenhouse/utils/logger';
import { sanitizeContent } from '../tools/external-search/sanitizer.js';
import { callMcpTool, describeMcpError } from './client.js';
import { redactSecrets, resolveConnectTarget } from './credentials.js';
import { discoverIfEmpty, getMcpDirectory, callableTools, type McpDirectoryServer } from './directory.js';
import { ConnectorAuthorizationRequired, ConnectorOAuthProvider, withConnectionLock } from './oauth.js';

/** What one Bots approval card asks about. */
export interface McpApprovalRequest {
  server: string;
  serverName: string;
  tool: string;
  arguments: Record<string, unknown>;
  destructive: boolean;
}
export type McpApprovalDecision = 'approve' | 'deny' | 'expired';

export interface McpCallToolContext {
  userId: string;
  sessionId?: string;
  /** Connector slugs this identity may reach (a Bot's list); null / undefined = every one. */
  connectors?: readonly string[] | null;
  /** Bots: ask the member on a card instead of trusting a model-set `confirm`. */
  approve?: (request: McpApprovalRequest) => Promise<McpApprovalDecision>;
}

/** The servers this identity may see: the directory narrowed by a Bot's connector list. */
export function visibleMcpServers(connectors?: readonly string[] | null): McpDirectoryServer[] {
  const directory = getMcpDirectory();
  if (!connectors) return [...directory];
  const allowed = new Set(connectors);
  return directory.filter((server) => allowed.has(server.slug));
}

function needsConnection(row: McpServerRow, reason: 'not_connected' | 'expired', why: string): McpNeedsConnection {
  return {
    needs_connection: true,
    server: row.slug,
    server_name: row.name,
    server_id: row.id,
    auth: row.auth_mode === 'oauth' ? 'oauth' : 'per_user',
    reason,
    error: `${why} A card under your reply lets them connect it: tell them so in one short line, without naming its buttons or any settings page, and call again once they say it is connected — do not retry before that.`,
  };
}

function isAuthFailure(err: unknown): boolean {
  if (err instanceof ConnectorAuthorizationRequired || err instanceof UnauthorizedError) return true;
  return /\b401\b|unauthori[sz]ed/i.test(err instanceof Error ? err.message : String(err));
}

export interface ConnectorInput {
  action: 'list' | 'describe' | 'call';
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  confirm?: boolean;
}
export interface ConnectorCallOptions {
  abortSignal?: AbortSignal;
  structured?: boolean;
  requireRemoteReadOnly?: boolean;
  maxBytes?: number;
}
const TOOL_SUMMARY_MAX = 160;
export async function executeConnectorTool(
  db: DatabaseProvider,
  ctx: McpCallToolContext,
  input: ConnectorInput,
  options?: ConnectorCallOptions,
) {
  const findServer = (slug: string | undefined) =>
    slug ? visibleMcpServers(ctx.connectors).find((s) => s.slug === slug) : undefined;

  const unknownServer = (slug: string | undefined) => {
    const known = visibleMcpServers(ctx.connectors)
      .map((s) => `"${s.slug}"`)
      .join(', ');
    return {
      error: slug
        ? `No connected MCP server "${slug}". Connected: ${known || '(none)'}.`
        : `server is required — one of ${known || '(none)'}.`,
    };
  };

  const execute = async (input: ConnectorInput, options?: ConnectorCallOptions) => {
    if (input.action === 'list') {
      const servers = visibleMcpServers(ctx.connectors);
      const statusById = new Map<number, McpConnectionStatus>();
      if (servers.some((s) => isPersonalAuthMode(s.auth_mode))) {
        for (const row of await db.mcpServers.listConnections(ctx.userId)) {
          const id = Number(row.provider.slice('mcp:'.length));
          statusById.set(id, row.access_token || row.provider_credential ? 'connected' : 'expired');
        }
      }
      return {
        servers: servers.map((server) => ({
          server: server.slug,
          name: server.name,
          description: server.description,
          ...(isPersonalAuthMode(server.auth_mode)
            ? { own_account: true, connection: statusById.get(server.id) ?? 'not_connected' }
            : {}),
          tools: server.tools.map((t) => ({
            name: t.name,
            description: t.description.slice(0, TOOL_SUMMARY_MAX),
            read_only: t.read_only,
            ...(t.destructive ? { destructive: true } : {}),
          })),
        })),
      };
    }

    let server = findServer(input.server);
    if (!server) return unknownServer(input.server);
    if (server.tools.length === 0) {
      // A member-account server nobody has connected yet: whatever the model
      // asked for, the answer is the member's connection — or, once they have
      // one, the tools it lists.
      const row = await db.mcpServers.getById(server.id);
      if (!row || !row.enabled) return { error: `"${server.slug}" is no longer available.` };
      const resolved = await resolveConnectTarget(db, row, ctx.userId);
      if (!resolved.ok) return needsConnection(row, resolved.reason, resolved.error);
      await discoverIfEmpty(db, row.id, ctx.userId);
      server = findServer(input.server);
      if (!server || server.tools.length === 0) {
        return {
          error: `"${input.server}" did not list any tools for this user's account. Tell the user; an administrator can refresh it.`,
        };
      }
    }
    let remote = input.tool ? server.tools.find((t) => t.name === input.tool) : undefined;
    if (!remote) {
      return {
        error: input.tool
          ? `"${server.slug}" has no callable tool "${input.tool}". Its tools: ${server.tools.map((t) => `"${t.name}"`).join(', ')}.`
          : `tool is required — one of ${server.tools.map((t) => `"${t.name}"`).join(', ')}.`,
      };
    }

    if (input.action === 'describe') {
      return {
        server: server.slug,
        tool: remote.name,
        description: remote.description,
        read_only: remote.read_only,
        destructive: remote.destructive,
        input_schema: remote.input_schema,
      };
    }

    // ── call ──
    // Re-read the row: the snapshot holds no credentials, and the server may
    // have been disabled since this turn's tools were built.
    const row = await db.mcpServers.getById(server.id);
    if (!row || !row.enabled) return { error: `"${server.slug}" is no longer available — it was disabled or removed.` };

    // Fresh policy, not the turn's directory snapshot. App sources require the remote annotation itself.
    const remoteName = remote.name;
    const current = callableTools(row).find((tool) => tool.name === remoteName);
    if (!current) return { error: 'Connector tool is no longer allowed.', reason: 'not_allowed' as const };
    if (
      options?.requireRemoteReadOnly &&
      !row.tools?.some((tool) => tool.name === remoteName && tool.read_only === true && !tool.destructive)
    ) {
      return { error: 'Connector tool must advertise read-only.', reason: 'not_read_only' as const };
    }
    remote = current;

    // Whose account: settled BEFORE asking for consent — approving a call that
    // cannot run (no connection) would be a question with no answer.
    const resolved = await resolveConnectTarget(db, row, ctx.userId);
    if (!resolved.ok) return needsConnection(row, resolved.reason, resolved.error);

    const args = (input.arguments ?? {}) as Record<string, unknown>;
    if (!remote.read_only) {
      if (ctx.approve) {
        const decision = await ctx.approve({
          server: server.slug,
          serverName: server.name,
          tool: remote.name,
          arguments: args,
          destructive: remote.destructive,
        });
        if (decision !== 'approve') {
          return decision === 'expired'
            ? {
                status: 'expired',
                error: `The user did not answer the approval card in time — "${remote.name}" was not run. Ask again only if they still want it.`,
              }
            : {
                status: 'denied',
                error: `The user declined — "${remote.name}" was not run. Do not retry unless they ask.`,
              };
        }
      } else if (input.confirm !== true) {
        return {
          error:
            `"${remote.name}" on "${server.slug}" is not marked read-only, so it may change data in that system. ` +
            'Tell the user exactly what this call will do, wait for an explicit yes, then call again with confirm:true.',
          needs_confirmation: true,
        };
      }
    }

    const startedAt = Date.now();
    try {
      const run = () => callMcpTool(resolved.target, remote.name, args, options?.abortSignal);
      const outcome = resolved.target.authProvider ? await withConnectionLock(row.id, ctx.userId, run) : await run();
      if (options?.structured) {
        if (outcome.isError) return { error: 'Connector tool failed.', reason: 'failed' as const };
        const serialized =
          outcome.structuredContent === undefined ? outcome.text : JSON.stringify(outcome.structuredContent);
        if (Buffer.byteLength(serialized) > (options.maxBytes ?? 512 * 1024))
          return { error: 'Connector result exceeds the size limit.', reason: 'too_large' as const };
        try {
          // Decode JSON escapes before redacting; a quoted/backslashed credential
          // otherwise no longer matches its serialized spelling.
          const data: unknown = JSON.parse(serialized, (_key, value: unknown) => {
            if (typeof value === 'string') return redactSecrets(value, resolved.secrets);
            if (value && typeof value === 'object' && !Array.isArray(value))
              return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [redactSecrets(key, resolved.secrets), item]),
              );
            return value;
          });
          return { data };
        } catch {
          return { error: 'Connector result is not JSON.', reason: 'map' as const };
        }
      }
      const safe = sanitizeContent(
        redactSecrets(outcome.text || '(the tool returned no content)', resolved.secrets),
        `mcp://${server.slug}/${remote.name}`,
      );
      logger.info('[mcp_call] remote tool ran', {
        server: server.slug,
        tool: remote.name,
        isError: outcome.isError,
        durationMs: Date.now() - startedAt,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
      });
      return {
        server: server.slug,
        tool: remote.name,
        is_error: outcome.isError,
        result: safe.text,
        ...(safe.flagged ? { flagged: true } : {}),
      };
    } catch (err) {
      const reason = redactSecrets(describeMcpError(err), resolved.secrets);
      if (isPersonalAuthMode(row.auth_mode) && isAuthFailure(err)) {
        // The provider expires a refused refresh itself; a token refused with
        // nothing to refresh it with ends here (a newer sign-in is left alone).
        const provider = resolved.target.authProvider;
        if (provider instanceof ConnectorOAuthProvider) await provider.expireUsedSignIn();
        logger.info('[mcp_call] member credential refused', { server: server.slug, tool: remote.name });
        return needsConnection(
          row,
          'expired',
          row.auth_mode === 'oauth'
            ? `The user's ${row.name} sign-in is no longer valid — they need to reconnect it.`
            : `${row.name} rejected the user's key — they need to update it.`,
        );
      }
      logger.warn('[mcp_call] remote tool failed', { server: server.slug, tool: remote.name, error: reason });
      return {
        error: `Calling "${remote.name}" on "${server.slug}" failed: ${reason}. Tell the user; do not retry the same call more than once.`,
      };
    }
  };
  return execute(input, options);
}

/** Read-only data consumers cannot opt into a write or provide their own identity. */
export function callConnectorTool(
  db: DatabaseProvider,
  ctx: McpCallToolContext,
  input: Omit<ConnectorInput, 'action' | 'confirm'>,
  options: ConnectorCallOptions = {},
) {
  return executeConnectorTool(
    db,
    ctx,
    { ...input, action: 'call' },
    { ...options, structured: true, requireRemoteReadOnly: true },
  );
}
