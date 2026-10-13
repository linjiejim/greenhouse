/**
 * Greenhouse calling out to one MCP server. One short-lived connection per operation
 * (connect, list or call, close) rather than a pool: an installed server may be slow,
 * restarted or stateful per session, and a stale pooled session would only show as a member's
 * tool call hanging. Who the call is made as is decided by the service, which hands over a
 * target with the credential in place.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ConnectorToolSpec, ConnectorTransport } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { FetchLike } from './network.js';

export const CONNECT_TIMEOUT_MS = 15_000;
export const LIST_TIMEOUT_MS = 15_000;
export const CALL_TIMEOUT_MS = 60_000;
/** Each request's own deadline: above a whole call, so the call's own timeout speaks first. */
export const REQUEST_TIMEOUT_MS = CALL_TIMEOUT_MS + CONNECT_TIMEOUT_MS + 15_000;
/** A server advertising more is cut here; nobody reads 500 tools. */
export const MAX_TOOLS = 200;
/**
 * The names the MCP spec recommends (and `/`, `:` for namespaced ones). A name reaches the model
 * in mcp_call's description, so a server cannot use one to write instructions there.
 */
const TOOL_NAME = /^[A-Za-z0-9_.:/-]{1,128}$/;
const MAX_TOOL_DESCRIPTION = 1000;

/** Everything needed to reach one server as one caller, the credential already in place. */
export interface Target {
  /** The endpoint, with a query-parameter key already in it: never log it. */
  url: string;
  transport: ConnectorTransport;
  /** A header key. */
  headers: Record<string, string>;
  /** A member's sign-in: the SDK adds the bearer token and refreshes it on 401. */
  authProvider?: OAuthClientProvider;
  fetch: FetchLike;
}

/** A tool's result as text the model can read: never raw binary. */
export interface CallOutcome {
  isError: boolean;
  text: string;
}

async function withClient<T>(target: Target, run: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const url = new URL(target.url);
  const options = {
    requestInit: { headers: target.headers },
    fetch: target.fetch,
    ...(target.authProvider ? { authProvider: target.authProvider } : {}),
  };
  const transport =
    target.transport === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
  const client = new Client({ name: 'greenhouse', version: '2' });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** undici says only "fetch failed"; the reason (a refused connection, TLS, a private address) is on `cause`. */
function withCause(error: unknown): string {
  const message = toErrorMessage(error);
  const cause =
    error && typeof error === 'object' ? (error as { cause?: { code?: unknown; message?: unknown } }).cause : null;
  if (!cause || !/fetch failed/i.test(message)) return message;
  const detail = [cause.code, cause.message].filter((part) => typeof part === 'string' && part).join(': ');
  return detail ? `${message}: ${detail}` : message;
}

/** The HTTP status a transport error carries (StreamableHTTPError, SseError). */
const statusOf = (error: unknown) =>
  error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'number'
    ? (error as { code: number }).code
    : null;

/** Whether a failure means the credential was refused: a key to replace or a sign-in to renew. */
export function isAuthFailure(error: unknown): boolean {
  if (error instanceof UnauthorizedError || (error instanceof Error && error.name === 'SignInRequired')) return true;
  return statusOf(error) === 401 || /\b401\b|unauthori[sz]ed|invalid_token/i.test(toErrorMessage(error));
}

/** One sentence an admin, a member or the model can act on. Callers take secrets out first. */
export function describeError(error: unknown): string {
  const message = withCause(error).slice(0, 400);
  // A reply that is not JSON-RPC comes back as the schema validator's issue list.
  if (/^\s*\[\s*\{/.test(message) && /"code":\s*"invalid_/.test(message)) {
    return 'The server answered with something that is not MCP (JSON-RPC).';
  }
  if (error instanceof Error && error.name === 'SignInRequired') return message;
  if (isAuthFailure(error)) return `The server refused the credential (${message}).`;
  if (statusOf(error) === 403 || /\b403\b|forbidden/i.test(message)) return `The server refused access (${message}).`;
  if (/EPRIVATEADDRESS|private network|private addresses/i.test(message)) {
    return `The address points into a private network (${message}).`;
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(message)) return `Could not reach the server (${message}).`;
  if (/timed? ?out|-32001|aborted/i.test(message)) return `The server did not answer in time (${message}).`;
  return message;
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'greenhouse', version: '2' } },
});

/** An `initialize` sent without the SDK, as a client's first request would be: for probing. */
export function knock(fetchLike: FetchLike, url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetchLike(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: INITIALIZE,
  });
}

/**
 * After a failed connection, knock once more without the SDK and say what the server actually
 * answered. Some services report a bad key in their own format (HTTP 200 with JSON that is not
 * JSON-RPC), which the SDK can only wait out. Null when there is nothing better to say.
 */
export async function explainFailedConnect(target: Target): Promise<string | null> {
  try {
    const response = await knock(target.fetch, target.url, target.headers);
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.includes('application/json')) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = (await response.text()).slice(0, 16_384);
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !('jsonrpc' in parsed)) {
      return `The server answered with something that is not MCP: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
    }
    return null;
  } catch {
    return null;
  }
}

/** Every tool the server advertises (paginated), shaped for the cache. */
export function listTools(target: Target, signal?: AbortSignal): Promise<ConnectorToolSpec[]> {
  return withClient(
    target,
    async (client) => {
      const tools: ConnectorToolSpec[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: LIST_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        });
        for (const tool of page.tools) {
          if (tools.length >= MAX_TOOLS) break;
          if (!TOOL_NAME.test(tool.name)) continue;
          tools.push({
            name: tool.name,
            description: (tool.description ?? tool.annotations?.title ?? '').slice(0, MAX_TOOL_DESCRIPTION),
            inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
            readOnly: tool.annotations?.readOnlyHint === true,
            destructive: tool.annotations?.destructiveHint === true,
          });
        }
        cursor = page.nextCursor;
      } while (cursor && tools.length < MAX_TOOLS);
      return tools;
    },
    signal,
  );
}

type ContentPart = { type?: string; text?: string; mimeType?: string; uri?: string; name?: string } & Record<
  string,
  unknown
>;

/** A CallToolResult's content as plain text: images and binary resources are named, never inlined. */
export function flattenResult(result: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
  toolResult?: unknown;
}): CallOutcome {
  const lines: string[] = [];
  const parts = Array.isArray(result.content) ? (result.content as ContentPart[]) : [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (typeof part.text === 'string') lines.push(part.text);
        break;
      case 'image':
      case 'audio':
        lines.push(`[${part.type} (${part.mimeType ?? 'unknown type'}), not shown]`);
        break;
      case 'resource_link':
        lines.push(`[resource: ${part.uri ?? ''}${part.name ? ` "${part.name}"` : ''}]`);
        break;
      case 'resource': {
        const resource = (part.resource ?? {}) as { uri?: string; text?: string; mimeType?: string };
        lines.push(
          typeof resource.text === 'string'
            ? resource.text
            : `[resource: ${resource.uri ?? ''} (${resource.mimeType ?? 'binary'}), not shown]`,
        );
        break;
      }
      default:
        break;
    }
  }
  // The tool's own machine-readable result: worth having when the text is empty or a summary.
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    lines.push(JSON.stringify(result.structuredContent));
  }
  // Servers from before 2025 answer with a bare `toolResult`.
  if (!lines.length && result.toolResult !== undefined) lines.push(JSON.stringify(result.toolResult));
  return { isError: result.isError === true, text: lines.join('\n').trim() };
}

/** Calls one tool and flattens its result. Throws on a transport or protocol failure. */
export function callTool(
  target: Target,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CallOutcome> {
  return withClient(
    target,
    async (client) => {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      return flattenResult(result as Parameters<typeof flattenResult>[0]);
    },
    signal,
  );
}
