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
 * main use case, and only a super can register a URL (spec 20261009 D5).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { McpRemoteTool, McpServerTransport } from '@greenhouse/types/mcp-servers';
import { toErrorMessage } from '@greenhouse/utils/error';

export const MCP_CONNECT_TIMEOUT_MS = 10_000;
export const MCP_LIST_TIMEOUT_MS = 15_000;
export const MCP_CALL_TIMEOUT_MS = 60_000;
/** A server advertising more than this is truncated; nobody reads 500 tools. */
export const MCP_MAX_TOOLS = 200;
const MCP_TOOL_DESCRIPTION_MAX = 1000;

/** Everything needed to reach one server, credential already decrypted. */
export interface McpConnectTarget {
  url: string;
  transport: McpServerTransport;
  authHeader: string | null;
  authValue: string | null;
}

/** A call result flattened for the model: text it can read, never raw binary. */
export interface McpCallOutcome {
  isError: boolean;
  text: string;
}

/**
 * The API's global dispatcher sends EVERY request through HTTPS_PROXY when one
 * is set (index.ts) — right for model and search APIs, wrong for an internal
 * MCP server the proxy cannot reach (loopback, the team's own network). MCP
 * traffic therefore uses its own dispatcher that honours NO_PROXY the standard
 * way, and undici's own fetch, since Node's built-in fetch rejects a dispatcher
 * from this undici (see apps/api/src/AGENTS.md).
 */
let proxyDispatcher: Dispatcher | null | undefined;
function mcpFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  if (proxyDispatcher === undefined) {
    const proxied = Boolean(
      process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy,
    );
    proxyDispatcher = proxied ? new EnvHttpProxyAgent() : null;
  }
  return undiciFetch(url, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
  }) as unknown as Promise<Response>;
}

function headersFor(target: McpConnectTarget): Record<string, string> {
  return target.authHeader && target.authValue ? { [target.authHeader]: target.authValue } : {};
}

async function withClient<T>(
  target: McpConnectTarget,
  run: (client: Client) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(target.url);
  const requestInit = { headers: headersFor(target) };
  const transport =
    target.transport === 'sse'
      ? new SSEClientTransport(url, { requestInit, fetch: mcpFetch })
      : new StreamableHTTPClientTransport(url, { requestInit, fetch: mcpFetch });
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
export function describeMcpError(err: unknown): string {
  const message = toErrorMessage(err);
  if (/401|unauthori[sz]ed/i.test(message)) return `the server rejected the credential (${message})`;
  if (/403|forbidden/i.test(message)) return `the server refused access (${message})`;
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message)) return `could not reach the server (${message})`;
  if (/timed? ?out|-32001/i.test(message)) return `the server did not answer in time (${message})`;
  return message;
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
