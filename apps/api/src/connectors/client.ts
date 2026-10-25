/**
 * MCP client — Greenhouse calling OUT to a remote MCP server.
 *
 * One short-lived connection per operation (connect → list/call → close)
 * rather than a pool: a remote server may be slow, restarted or stateful per
 * session, and a stale pooled session is a failure nobody would see until a
 * member's tool call hangs. The handshake costs one round trip; tool calls are
 * rare compared with chat turns.
 *
 * Remote transports only (Streamable HTTP, legacy SSE) through the official
 * SDK client. Who the call is made AS is decided by `credentials.ts`, which
 * hands this module a ready target; where it may connect is `network.ts`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { CONNECTOR_TOOL_NAME_PATTERN, type ConnectorTool, type ConnectorTransport } from '@greenhouse/types/connectors';
import { toErrorMessage } from '@greenhouse/utils/error';
import { connectorFetch, type FetchLike, type NetworkPolicy } from './network.js';

/** Generous: public servers are often reached through an egress proxy, and a cold first handshake is slow. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
export const MCP_LIST_TIMEOUT_MS = 15_000;
export const MCP_CALL_TIMEOUT_MS = 60_000;
/** Whole-operation deadline (connect + list/call + close); also each HTTP request's ceiling. */
export const MCP_OPERATION_DEADLINE_MS = 90_000;
/** A server advertising more than this is truncated; nobody reads 500 tools. */
export const MCP_MAX_TOOLS = 200;
export const MCP_TOOL_DESCRIPTION_MAX = 1000;

/** Everything needed to reach one server as one caller, credential already in place. */
export interface McpConnectTarget {
  /** The endpoint — with a query-parameter key already appended, so never log it. */
  url: string;
  transport: ConnectorTransport;
  /** Extra request headers (a header key). */
  headers: Record<string, string>;
  /** An OAuth sign-in: the SDK adds the bearer token and refreshes it on 401. */
  authProvider?: OAuthClientProvider;
  policy: NetworkPolicy;
}

/** A call result flattened for the model: text it can read, never raw binary. */
export interface McpCallOutcome {
  isError: boolean;
  text: string;
  /** Bytes of text handed back (for the audit row). */
  bytes: number;
}

/** fetch for one connector target (its network policy, the operation deadline). */
export function targetFetch(target: Pick<McpConnectTarget, 'url' | 'policy'>, timeoutMs = MCP_OPERATION_DEADLINE_MS) {
  return connectorFetch(target.url, target.policy, timeoutMs);
}

async function withClient<T>(
  target: McpConnectTarget,
  run: (client: Client, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(target.url);
  const fetchFn: FetchLike = targetFetch(target);
  const options = {
    requestInit: { headers: target.headers },
    fetch: fetchFn,
    ...(target.authProvider ? { authProvider: target.authProvider } : {}),
  };
  const transport =
    target.transport === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
  const client = new Client({ name: 'greenhouse', version: process.env.APP_VERSION || '3.0.0' });
  const overall = AbortSignal.timeout(MCP_OPERATION_DEADLINE_MS);
  const combined = signal ? AbortSignal.any([signal, overall]) : overall;
  try {
    await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS, signal: combined });
    return await run(client, combined);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** undici says only "fetch failed"; the reason (ECONNRESET, a TLS error, a refused host) is on `cause`. */
function withCause(err: unknown): string {
  const message = toErrorMessage(err);
  const cause =
    err && typeof err === 'object' ? (err as { cause?: { code?: unknown; message?: unknown } }).cause : null;
  if (!cause || !/fetch failed/i.test(message)) return message;
  const detail = [cause.code, cause.message].filter((part) => typeof part === 'string' && part).join(': ');
  return detail ? `${message}: ${detail}` : message;
}

/**
 * One sentence an admin (or the model) can act on. The SDK's own messages name
 * HTTP statuses and error codes; the URL and credential pass `redactSecrets`
 * before anything is shown.
 */
export function describeMcpError(err: unknown): string {
  const message = withCause(err).slice(0, 600);
  // The SDK rejects a reply that is not JSON-RPC with its schema validator's issue list.
  if (/^\s*\[\s*\{/.test(message) && /"code":\s*"invalid_/.test(message)) {
    return 'the server answered with something that is not valid MCP (JSON-RPC)';
  }
  if (/non-public|not public|private network/i.test(message)) return `the address is not allowed (${message})`;
  if (/401|unauthori[sz]ed/i.test(message)) return `the server rejected the credential (${message})`;
  if (/403|forbidden/i.test(message)) return `the server refused access (${message})`;
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message)) return `could not reach the server (${message})`;
  if (/timed? ?out|-32001|aborted/i.test(message)) return `the server did not answer in time (${message})`;
  return message;
}

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'greenhouse', version: '0' } },
});

/** A raw `initialize` POST without the SDK, for probing what a server answers. */
export async function knock(
  target: Pick<McpConnectTarget, 'url' | 'policy'> & { headers?: Record<string, string> },
  timeoutMs = 10_000,
): Promise<Response> {
  return targetFetch(target, timeoutMs)(target.url, {
    method: 'POST',
    headers: {
      ...(target.headers ?? {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: INITIALIZE_BODY,
  });
}

/**
 * When a connection fails, knock once more without the SDK and say what the
 * server actually answered. Some services report a bad key as HTTP 200 with a
 * JSON body that is not JSON-RPC, which the SDK can only wait out. Returns null
 * when there is nothing better to say. Callers redact secrets.
 */
export async function explainFailedConnect(target: McpConnectTarget): Promise<string | null> {
  try {
    const res = await knock(target, 8_000);
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('application/json')) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = (await res.text()).slice(0, 16_384);
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !('jsonrpc' in parsed)) {
      const excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      return `the server answered with something that is not MCP: ${excerpt}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** List every tool the server advertises (paginated, capped), shaped for the cache. */
export async function discoverMcpTools(target: McpConnectTarget, signal?: AbortSignal): Promise<ConnectorTool[]> {
  return withClient(
    target,
    async (client, combined) => {
      const tools: ConnectorTool[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: MCP_LIST_TIMEOUT_MS,
          signal: combined,
        });
        for (const tool of page.tools) {
          if (tools.length >= MCP_MAX_TOOLS) break;
          // A name the model could not pass back (or a duplicate) is not a callable tool.
          if (!CONNECTOR_TOOL_NAME_PATTERN.test(tool.name) || seen.has(tool.name)) continue;
          seen.add(tool.name);
          tools.push({
            name: tool.name,
            description: (tool.description ?? tool.annotations?.title ?? '').slice(0, MCP_TOOL_DESCRIPTION_MAX),
            input_schema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
            read_only: tool.annotations?.readOnlyHint === true,
            destructive: tool.annotations?.destructiveHint === true,
          });
        }
        cursor = page.nextCursor;
        pages++;
      } while (cursor && tools.length < MCP_MAX_TOOLS && pages < 20);
      return tools;
    },
    signal,
  );
}

type ContentPart = { type?: string; text?: string; mimeType?: string; uri?: string; name?: string } & Record<
  string,
  unknown
>;

/** Flatten an MCP CallToolResult's content into plain text the model can read. */
export function flattenMcpResult(result: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
  toolResult?: unknown;
}): McpCallOutcome {
  const lines: string[] = [];
  const parts = Array.isArray(result.content) ? (result.content as ContentPart[]) : [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (typeof part.text === 'string') lines.push(part.text);
        break;
      case 'image':
      case 'audio':
        lines.push(`[${part.type} result (${part.mimeType ?? 'unknown type'}) — not shown]`);
        break;
      case 'resource_link':
        lines.push(`[resource: ${part.uri ?? ''}${part.name ? ` "${part.name}"` : ''}]`);
        break;
      case 'resource': {
        const resource = (part.resource ?? {}) as { uri?: string; text?: string; mimeType?: string };
        lines.push(
          typeof resource.text === 'string'
            ? resource.text
            : `[resource: ${resource.uri ?? ''} (${resource.mimeType ?? 'binary'}) — not shown]`,
        );
        break;
      }
      default:
        break;
    }
  }
  // Structured output is the tool's own machine-readable result.
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    lines.push(JSON.stringify(result.structuredContent));
  }
  // Pre-2025 servers answer with a bare `toolResult`.
  if (lines.length === 0 && result.toolResult !== undefined) lines.push(JSON.stringify(result.toolResult));
  const text = lines.join('\n').trim();
  return { isError: result.isError === true, text, bytes: Buffer.byteLength(text, 'utf8') };
}

/** Call one tool and flatten its result. Throws on transport/protocol failure. */
export async function callMcpTool(
  target: McpConnectTarget,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpCallOutcome> {
  return withClient(
    target,
    async (client, combined) => {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: MCP_CALL_TIMEOUT_MS,
        signal: combined,
      });
      return flattenMcpResult(result as Parameters<typeof flattenMcpResult>[0]);
    },
    signal,
  );
}
