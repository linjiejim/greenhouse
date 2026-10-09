/**
 * External MCP servers — the CLIENT side of MCP (Greenhouse calling out).
 *
 * Not to be confused with `@greenhouse/types/mcp`, which carves up Greenhouse's
 * own `/api/mcp` SERVER surface for consent. Here a super registers a remote
 * MCP server once; members granted the `mcp_call` tool then reach its tools
 * from chat through that one gateway tool (spec 20261009 D5).
 *
 * Shared by the admin route (validation) and the Administration page (form),
 * so the two can never disagree about what a valid entry is.
 */

/** Remote transports only — a stdio server would be arbitrary code in the API process. */
export const MCP_SERVER_TRANSPORTS = ['streamable_http', 'sse'] as const;
export type McpServerTransport = (typeof MCP_SERVER_TRANSPORTS)[number];

/**
 * The handle the model uses (`mcp_call({ server: "<slug>" })`). Lowercase, short
 * and stable: renaming it would break every saved instruction that names it.
 */
export const MCP_SERVER_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export const MCP_SERVER_NAME_MAX = 80;
export const MCP_SERVER_DESCRIPTION_MAX = 500;
/** Header names per RFC 7230 token characters. */
export const MCP_AUTH_HEADER_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/** One tool as the server advertised it at the last refresh. */
export interface McpRemoteTool {
  name: string;
  description: string;
  /** The tool's JSON Schema for its arguments, as advertised. */
  input_schema: Record<string, unknown>;
  /** Server-declared `readOnlyHint`. Anything not declared read-only needs the user's confirmation. */
  read_only: boolean;
  /** Server-declared `destructiveHint`, surfaced to the model as a warning. */
  destructive: boolean;
}

/** What the admin API returns — never the auth header's value. */
export interface McpServerView {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  url: string;
  transport: McpServerTransport;
  auth_header: string | null;
  /** Whether a header value is stored (the value itself never leaves the server). */
  has_auth_value: boolean;
  enabled: boolean;
  /** Tool names members may call; null = every advertised tool. */
  allowed_tools: string[] | null;
  tools: McpRemoteTool[];
  tools_refreshed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface McpServerInput {
  slug: string;
  name: string;
  description?: string | null;
  url: string;
  transport?: McpServerTransport;
  auth_header?: string | null;
  /** Write-only. Omitted on update = keep the stored value; '' = clear it. */
  auth_value?: string;
  enabled?: boolean;
  allowed_tools?: string[] | null;
}

export type McpServerUpdate = Partial<Omit<McpServerInput, 'slug'>>;

/** Shape-check an entry; returns the first problem in words an admin can act on. */
export function validateMcpServerInput(
  input: Partial<McpServerInput>,
  opts: { partial?: boolean } = {},
): string | null {
  const need = (key: keyof McpServerInput) => !opts.partial || input[key] !== undefined;

  if (need('slug') && (typeof input.slug !== 'string' || !MCP_SERVER_SLUG_PATTERN.test(input.slug))) {
    return 'slug must start with a lowercase letter and use only a-z, 0-9, "-" or "_" (max 32)';
  }
  if (need('name')) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > MCP_SERVER_NAME_MAX) return `name is required (max ${MCP_SERVER_NAME_MAX} characters)`;
  }
  if (input.description && input.description.length > MCP_SERVER_DESCRIPTION_MAX) {
    return `description must be ${MCP_SERVER_DESCRIPTION_MAX} characters or fewer`;
  }
  if (need('url')) {
    let url: URL | null;
    try {
      url = new URL(String(input.url ?? ''));
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      return 'url must be an http(s) URL of the server\'s MCP endpoint (for example "https://example.com/mcp")';
    }
    if (url.username || url.password) return 'put credentials in the auth header, not in the url';
  }
  if (input.transport !== undefined && !MCP_SERVER_TRANSPORTS.includes(input.transport)) {
    return `transport must be one of ${MCP_SERVER_TRANSPORTS.map((t) => `"${t}"`).join(', ')}`;
  }
  if (input.auth_header && !MCP_AUTH_HEADER_PATTERN.test(input.auth_header)) {
    return 'auth_header must be a plain HTTP header name (for example "Authorization")';
  }
  if (input.allowed_tools != null) {
    if (!Array.isArray(input.allowed_tools) || input.allowed_tools.some((t) => typeof t !== 'string' || !t)) {
      return 'allowed_tools must be a list of tool names, or null for every tool';
    }
  }
  return null;
}
