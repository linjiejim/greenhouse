/**
 * MCP client — Greenhouse calling OUT to a remote MCP server.
 *
 * One short-lived connection per operation (connect → list/call → close)
 * rather than a pool: an admin-registered server may be slow, restarted or
 * stateful per session, and a stale pooled session is a failure mode nobody
 * would see until a member's tool call hangs. The handshake costs one round
 * trip; tool calls are rare compared with chat turns.
 *
 * Remote transports only (Streamable HTTP, legacy SSE). Private addresses are
 * allowed on purpose: an internal MCP server on the team's own network is the
 * main use case, and only a super can register a URL (spec 20261009 D5). Who
 * the call is made AS — nobody, the shared credential, a member's key or a
 * member's OAuth sign-in — is decided by `credentials.ts`, which hands this
 * module a ready target.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { McpRemoteTool, McpServerTransport } from '@greenhouse/types/mcp-servers';
import { toErrorMessage } from '@greenhouse/utils/error';

/** Generous: public servers are often reached through an egress proxy, and a cold first handshake is slow. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
export const MCP_LIST_TIMEOUT_MS = 15_000;
export const MCP_CALL_TIMEOUT_MS = 60_000;
/** A server advertising more than this is truncated; nobody reads 500 tools. */
export const MCP_MAX_TOOLS = 200;
const MCP_TOOL_DESCRIPTION_MAX = 1000;

/** Everything needed to reach one server as one caller, credential already in place. */
export interface McpConnectTarget {
  /** The endpoint — with a query-parameter credential already appended, so never log it. */
  url: string;
  transport: McpServerTransport;
  /** Extra request headers (a header credential). */
  headers: Record<string, string>;
  /** A member's OAuth sign-in: the SDK adds the bearer token and refreshes it on 401. */
  authProvider?: OAuthClientProvider;
}

/** A call result flattened for the model: text it can read, never raw binary. */
export interface McpCallOutcome {
  isError: boolean;
  text: string;
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The API's global dispatcher sends EVERY request through HTTPS_PROXY when one
 * is set (index.ts) — right for model and search APIs, wrong for an internal
 * MCP server the proxy cannot reach (loopback, the team's own network). MCP
 * traffic therefore uses its own dispatcher that honours NO_PROXY the standard
 * way, and undici's own fetch, since Node's built-in fetch rejects a dispatcher
 * from this undici (see apps/api/src/AGENTS.md).
 */
let proxyDispatcher: Dispatcher | null | undefined;
/** Statuses whose response may not carry a body (the Response constructor rejects one). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
export async function mcpFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  if (proxyDispatcher === undefined) {
    const proxied = Boolean(
      process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy,
    );
    proxyDispatcher = proxied ? new EnvHttpProxyAgent() : null;
  }
  const res = await undiciFetch(url, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
  });
  // Re-wrapped as the GLOBAL Response: the SDK reads an OAuth error body only
  // after `input instanceof Response`, and this undici's Response is another
  // class — `invalid_grant` / `invalid_client` were otherwise downgraded to a
  // generic server error, so a dead client was never re-registered and a
  // refused refresh never invalidated. The body stays a stream (SSE keeps flowing).
  return new Response(NULL_BODY_STATUSES.has(res.status) ? null : (res.body as ReadableStream<Uint8Array> | null), {
    status: res.status,
    statusText: res.statusText,
    headers: new Headers([...res.headers]),
  });
}

/**
 * `mcpFetch` restricted to what one server may make us fetch: its own origin,
 * or any https URL. The OAuth hops (protected-resource metadata → authorization
 * server → token endpoint) go wherever the remote server's metadata points;
 * without this a server could aim the API at any plain-http address on the
 * internal network (spec 20261009-mcp-connectors D3).
 */
export function guardedMcpFetch(serverUrl: string): FetchLike {
  const origin = new URL(serverUrl).origin;
  return (url, init) => {
    const target = new URL(String(url));
    if (target.origin !== origin && target.protocol !== 'https:') {
      return Promise.reject(
        new Error(`refused to follow "${target.origin}": only https or the MCP server's own origin are allowed`),
      );
    }
    return mcpFetch(target, init);
  };
}

async function withClient<T>(
  target: McpConnectTarget,
  run: (client: Client) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(target.url);
  const options = {
    requestInit: { headers: target.headers },
    fetch: guardedMcpFetch(target.url),
    ...(target.authProvider ? { authProvider: target.authProvider } : {}),
  };
  const transport =
    target.transport === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
  const client = new Client({ name: 'greenhouse', version: process.env.APP_VERSION || '0.1.0' });
  try {
    await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Turn a transport/protocol failure into one sentence an admin (or the model)
 * can act on. The SDK's own messages name HTTP statuses and error codes, which
 * is fine for the admin page; the URL and credential never appear in them.
 */
/** undici says only "fetch failed"; the reason (ECONNRESET, a TLS error, a proxy refusal) is on `cause`. */
function withCause(err: unknown): string {
  const message = toErrorMessage(err);
  const cause =
    err && typeof err === 'object' ? (err as { cause?: { code?: unknown; message?: unknown } }).cause : null;
  if (!cause || !/fetch failed/i.test(message)) return message;
  const detail = [cause.code, cause.message].filter((part) => typeof part === 'string' && part).join(': ');
  return detail ? `${message}: ${detail}` : message;
}

export function describeMcpError(err: unknown): string {
  const message = withCause(err);
  // The SDK rejects a reply that is not JSON-RPC with its schema validator's
  // issue list — pages of JSON that tell an admin nothing.
  if (/^\s*\[\s*\{/.test(message) && /"code":\s*"invalid_/.test(message)) {
    return 'the server answered with something that is not valid MCP (JSON-RPC)';
  }
  if (/401|unauthori[sz]ed/i.test(message)) return `the server rejected the credential (${message})`;
  if (/403|forbidden/i.test(message)) return `the server refused access (${message})`;
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message)) return `could not reach the server (${message})`;
  if (/timed? ?out|-32001/i.test(message)) return `the server did not answer in time (${message})`;
  return message;
}

/**
 * When a connection fails, knock once more without the SDK and say what the
 * server actually answered. Some services report a bad key in their own format
 * — HTTP 200 with a JSON body that is not JSON-RPC (Amap answers
 * `{"status":"0","info":"INVALID_USER_KEY"}`) — which the SDK can only wait
 * out, so the member would otherwise read "did not answer in time". Returns
 * null when there is nothing better to say. Callers redact secrets.
 */
export async function explainFailedConnect(target: McpConnectTarget): Promise<string | null> {
  try {
    const res = await guardedMcpFetch(target.url)(target.url, {
      method: 'POST',
      headers: { ...target.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'greenhouse', version: '0' } },
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('application/json')) return null;
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

/** List every tool the server advertises (paginated), shaped for the cache. */
export async function discoverMcpTools(target: McpConnectTarget, signal?: AbortSignal): Promise<McpRemoteTool[]> {
  return withClient(
    target,
    async (client) => {
      const tools: McpRemoteTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: MCP_LIST_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        });
        for (const tool of page.tools) {
          if (tools.length >= MCP_MAX_TOOLS) break;
          tools.push({
            name: tool.name,
            description: (tool.description ?? tool.annotations?.title ?? '').slice(0, MCP_TOOL_DESCRIPTION_MAX),
            input_schema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
            read_only: tool.annotations?.readOnlyHint === true,
            destructive: tool.annotations?.destructiveHint === true,
          });
        }
        cursor = page.nextCursor;
      } while (cursor && tools.length < MCP_MAX_TOOLS);
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
  // Structured output is the tool's own machine-readable result: worth having
  // when the text is empty or just a summary of it.
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    lines.push(JSON.stringify(result.structuredContent));
  }
  // Pre-2025 servers answer with a bare `toolResult`.
  if (lines.length === 0 && result.toolResult !== undefined) lines.push(JSON.stringify(result.toolResult));
  return { isError: result.isError === true, text: lines.join('\n').trim() };
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
    async (client) => {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: MCP_CALL_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      return flattenMcpResult(result as Parameters<typeof flattenMcpResult>[0]);
    },
    signal,
  );
}
