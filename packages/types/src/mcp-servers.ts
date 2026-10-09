/**
 * External MCP servers ("connectors") — the CLIENT side of MCP (Greenhouse calling out).
 *
 * Not to be confused with `@greenhouse/types/mcp`, which carves up Greenhouse's
 * own `/api/mcp` SERVER surface for consent. Here a super installs a remote MCP
 * server once; members granted the `mcp_call` tool then reach its tools through
 * that one gateway tool (spec 20261009 D5). Servers whose `auth_mode` is
 * `per_user` or `oauth` additionally need each member's own connection
 * (spec 20261009-mcp-connectors).
 *
 * Shared by the admin route (validation), the member routes and the web pages
 * (forms), so they can never disagree about what a valid entry is.
 */

/** Remote transports only — a stdio server would be arbitrary code in the API process. */
export const MCP_SERVER_TRANSPORTS = ['streamable_http', 'sse'] as const;
export type McpServerTransport = (typeof MCP_SERVER_TRANSPORTS)[number];

/**
 * Whose credential a call carries:
 * - `none`     — a public server, nothing is sent;
 * - `shared`   — the admin's one credential, used for every member;
 * - `per_user` — each member pastes their own key / token;
 * - `oauth`    — each member signs in (MCP authorization spec: OAuth 2.1 + PKCE).
 */
export const MCP_AUTH_MODES = ['none', 'shared', 'per_user', 'oauth'] as const;
export type McpAuthMode = (typeof MCP_AUTH_MODES)[number];

/** Modes where each member needs their own connection before calling. */
export function isPersonalAuthMode(mode: McpAuthMode): mode is 'per_user' | 'oauth' {
  return mode === 'per_user' || mode === 'oauth';
}

/**
 * The handle the model uses (`mcp_call({ server: "<slug>" })`). Lowercase, short
 * and stable: renaming it would break every saved instruction that names it.
 */
export const MCP_SERVER_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export const MCP_SERVER_NAME_MAX = 80;
export const MCP_SERVER_DESCRIPTION_MAX = 500;
export const MCP_CREDENTIAL_HELP_MAX = 500;
export const MCP_OAUTH_SCOPE_MAX = 512;
export const MCP_AUTH_PREFIX_MAX = 32;
/** Header names per RFC 7230 token characters. */
export const MCP_AUTH_HEADER_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** A query parameter that carries a key (`key`, `api_key`, `exaApiKey`, …). */
export const MCP_AUTH_QUERY_PARAM_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** One tool as the server advertised it at the last refresh. */
export interface McpRemoteTool {
  name: string;
  description: string;
  /** The tool's JSON Schema for its arguments, as advertised. */
  input_schema: Record<string, unknown>;
  /** Server-declared `readOnlyHint`. Anything not read-only needs the member's confirmation / approval. */
  read_only: boolean;
  /** Server-declared `destructiveHint`, surfaced to the model as a warning. */
  destructive: boolean;
}

/**
 * Whether a call to this tool may run without the member's confirmation: the
 * server declared it read-only, or a super (or the official catalog) vouched for
 * it — unless the server itself calls it destructive (spec D10).
 */
export function isEffectivelyReadOnly(
  tool: Pick<McpRemoteTool, 'name' | 'read_only' | 'destructive'>,
  vouched: readonly string[] | null | undefined,
): boolean {
  if (tool.read_only) return true;
  return !tool.destructive && Boolean(vouched?.includes(tool.name));
}

/** How the instance identifies itself to a server's OAuth authorization server. */
export type McpOAuthClientSource = 'dynamic' | 'metadata_document' | 'manual';

/** What the admin API returns — never a credential or client secret. */
export interface McpServerView {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  url: string;
  transport: McpServerTransport;
  auth_mode: McpAuthMode;
  auth_header: string | null;
  auth_query_param: string | null;
  auth_value_prefix: string | null;
  /** Whether a shared credential is stored (the value itself never leaves the server). */
  has_auth_value: boolean;
  credential_help: string | null;
  credential_url: string | null;
  oauth_scope: string | null;
  /** The instance's OAuth client at this server, without its secret. */
  oauth_client: { source: McpOAuthClientSource; client_id: string; has_secret: boolean } | null;
  enabled: boolean;
  /** Tool names members may call; null = every advertised tool. */
  allowed_tools: string[] | null;
  /** Tool names vouched read-only although the server does not say so. */
  read_only_tools: string[] | null;
  catalog_id: string | null;
  tools: McpRemoteTool[];
  tools_refreshed_at: string | null;
  last_error: string | null;
  /** How many members hold a connection (per_user / oauth); 0 otherwise. */
  connection_count: number;
  created_at: string;
  updated_at: string;
}

export interface McpServerInput {
  slug: string;
  name: string;
  description?: string | null;
  url: string;
  transport?: McpServerTransport;
  auth_mode?: McpAuthMode;
  auth_header?: string | null;
  auth_query_param?: string | null;
  auth_value_prefix?: string | null;
  /** Write-only shared credential. Omitted on update = keep the stored value; '' = clear it. */
  auth_value?: string;
  credential_help?: string | null;
  credential_url?: string | null;
  oauth_scope?: string | null;
  /** A client the admin registered by hand (servers without dynamic registration, e.g. GitHub). */
  oauth_client_id?: string | null;
  /** Write-only. Omitted = keep; '' = clear. */
  oauth_client_secret?: string;
  enabled?: boolean;
  allowed_tools?: string[] | null;
  read_only_tools?: string[] | null;
}

export type McpServerUpdate = Partial<Omit<McpServerInput, 'slug'>>;

function isHttpUrl(raw: unknown, protocols: readonly string[] = ['https:', 'http:']): URL | null {
  try {
    const url = new URL(String(raw ?? ''));
    return protocols.includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function isNameList(value: unknown): boolean {
  return Array.isArray(value) && value.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 200);
}

/** Shape-check an entry field by field; returns the first problem in words an admin can act on. */
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
    const url = isHttpUrl(input.url);
    if (!url) {
      return 'url must be an http(s) URL of the server\'s MCP endpoint (for example "https://example.com/mcp")';
    }
    if (url.username || url.password) return 'put credentials in the auth header, not in the url';
  }
  if (input.transport !== undefined && !MCP_SERVER_TRANSPORTS.includes(input.transport)) {
    return `transport must be one of ${MCP_SERVER_TRANSPORTS.map((t) => `"${t}"`).join(', ')}`;
  }
  if (input.auth_mode !== undefined && !MCP_AUTH_MODES.includes(input.auth_mode)) {
    return `auth_mode must be one of ${MCP_AUTH_MODES.map((m) => `"${m}"`).join(', ')}`;
  }
  if (input.auth_header && !MCP_AUTH_HEADER_PATTERN.test(input.auth_header)) {
    return 'auth_header must be a plain HTTP header name (for example "Authorization")';
  }
  if (input.auth_query_param && !MCP_AUTH_QUERY_PARAM_PATTERN.test(input.auth_query_param)) {
    return 'auth_query_param must be a plain query parameter name (for example "key")';
  }
  if (input.auth_header && input.auth_query_param) {
    return 'send the credential either in a header or in a query parameter, not both';
  }
  if (input.auth_value_prefix != null) {
    if (input.auth_value_prefix.length > MCP_AUTH_PREFIX_MAX || /[\r\n]/.test(input.auth_value_prefix)) {
      return `auth_value_prefix must be one line of at most ${MCP_AUTH_PREFIX_MAX} characters (for example "Bearer ")`;
    }
  }
  if (input.credential_help && input.credential_help.length > MCP_CREDENTIAL_HELP_MAX) {
    return `credential_help must be ${MCP_CREDENTIAL_HELP_MAX} characters or fewer`;
  }
  if (input.credential_url && !isHttpUrl(input.credential_url, ['https:'])) {
    return 'credential_url must be an https URL';
  }
  if (input.oauth_scope != null) {
    if (input.oauth_scope.length > MCP_OAUTH_SCOPE_MAX || /[\r\n"\\]/.test(input.oauth_scope)) {
      return `oauth_scope must be space-separated scopes, at most ${MCP_OAUTH_SCOPE_MAX} characters`;
    }
  }
  if (input.oauth_client_id != null && (input.oauth_client_id.length > 512 || /\s/.test(input.oauth_client_id))) {
    return 'oauth_client_id must be the client id the authorization server issued (no spaces)';
  }
  if (input.allowed_tools != null && !isNameList(input.allowed_tools)) {
    return 'allowed_tools must be a list of tool names, or null for every tool';
  }
  if (input.read_only_tools != null && !isNameList(input.read_only_tools)) {
    return 'read_only_tools must be a list of tool names, or null';
  }
  return null;
}

/** The settings that decide how a call authenticates, after an update is merged onto the row. */
export interface McpAuthConfig {
  auth_mode: McpAuthMode;
  auth_header: string | null;
  auth_query_param: string | null;
  has_shared_credential: boolean;
}

/**
 * The cross-field rule a merged configuration must satisfy — checked after the
 * per-field shape check, because a partial update can only be judged together
 * with what is already stored.
 */
export function validateMcpAuthConfig(config: McpAuthConfig): string | null {
  const placed = Boolean(config.auth_header || config.auth_query_param);
  switch (config.auth_mode) {
    case 'none':
    case 'oauth':
      if (config.has_shared_credential) {
        return `a "${config.auth_mode}" server sends no shared credential — clear it or pick "shared"`;
      }
      return null;
    case 'shared':
      if (!config.has_shared_credential) return 'a "shared" server needs the credential every member will use';
      if (!placed) return 'say where the credential goes: a header name or a query parameter';
      return null;
    case 'per_user':
      if (config.has_shared_credential) return 'a "per_user" server stores no shared credential — clear it';
      if (!placed) return "say where each member's key goes: a header name or a query parameter";
      return null;
  }
}

// ─── Member side ─────────────────────────────────────────

/**
 * A member's standing with one connector:
 * - `not_needed`    — none / shared: nothing to connect, it just works;
 * - `not_connected` — per_user / oauth with no credential of theirs;
 * - `connected`     — their key or sign-in is stored;
 * - `expired`       — their sign-in stopped working (refresh refused); reconnect.
 */
export type McpConnectionStatus = 'not_needed' | 'not_connected' | 'connected' | 'expired';

/** One connector as a member sees it (Settings → Connectors). */
export interface McpConnectorView {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  auth_mode: McpAuthMode;
  credential_help: string | null;
  credential_url: string | null;
  catalog_id: string | null;
  tool_count: number;
  read_only_tool_count: number;
  status: McpConnectionStatus;
  /** When the member connected (or last re-connected). */
  connected_at: string | null;
  /** Why an `expired` connection stopped working. */
  error: string | null;
}

/** `mcp_call`'s answer when the member has to connect first — the chat renders a "Connect" card from it. */
export interface McpNeedsConnection {
  needs_connection: true;
  server: string;
  server_name: string;
  server_id: number;
  auth: 'per_user' | 'oauth';
  reason: 'not_connected' | 'expired';
  error: string;
}

export function isMcpNeedsConnection(value: unknown): value is McpNeedsConnection {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.needs_connection === true && typeof v.server === 'string' && typeof v.server_id === 'number';
}

/** The message the OAuth result page posts to the window that opened it. */
export const MCP_CONNECT_MESSAGE_TYPE = 'greenhouse:connector';
export interface McpConnectMessage {
  type: typeof MCP_CONNECT_MESSAGE_TYPE;
  server_id: number;
  ok: boolean;
}

// ─── The official connector catalog (`connectors/*.json`) ───

/** The `_meta` key under which a catalog file keeps Greenhouse's own fields (reverse-DNS, per the Registry convention). */
export const CONNECTOR_CATALOG_META_KEY = 'com.linjiejim.greenhouse/connector';

export const CONNECTOR_CATEGORIES = ['docs', 'dev', 'productivity', 'data', 'maps', 'search', 'other'] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

/**
 * How far a catalog entry was verified against the live server, so the catalog
 * never claims more than was checked:
 * - `call`      — connected and called a tool;
 * - `sign_in`   — OAuth discovery + client registration worked up to the provider's consent page;
 * - `handshake` — the server answered; calling it needs a key nobody on the catalog team holds.
 */
export const CONNECTOR_VERIFICATION_LEVELS = ['call', 'sign_in', 'handshake'] as const;
export type ConnectorVerificationLevel = (typeof CONNECTOR_VERIFICATION_LEVELS)[number];

/** One catalog entry as the admin API serves it. */
export interface McpCatalogEntry {
  /** The server's name in the official MCP Registry style (`app.linear/linear`) — the catalog id. */
  id: string;
  slug: string;
  title: string;
  title_zh: string | null;
  description: string;
  description_zh: string;
  category: ConnectorCategory;
  website_url: string | null;
  icon_url: string | null;
  url: string;
  transport: McpServerTransport;
  auth: {
    mode: McpAuthMode;
    header?: string;
    query_param?: string;
    prefix?: string;
    help?: string;
    help_zh?: string;
    help_url?: string;
    scope?: string;
    /** Members can connect without the admin registering anything at the provider. */
    zero_config: boolean;
  };
  /** Tools the catalog vouches are read-only though the server does not say so. */
  read_only_tools: string[];
  verification: { level: ConnectorVerificationLevel; date: string; notes?: string };
  /** The slug it is installed under on this instance, if it is. */
  installed_slug?: string | null;
}

/** A remote server found in the official MCP Registry (unvetted). */
export interface McpRegistryResult {
  name: string;
  title: string | null;
  description: string;
  version: string;
  website_url: string | null;
  remotes: Array<{
    transport: McpServerTransport;
    url: string;
    headers: Array<{ name: string; description: string | null; required: boolean; secret: boolean }>;
  }>;
  /** The catalog id when the same server is in the official catalog (install that instead). */
  catalog_id: string | null;
}

/** What an address asks for before it is installed (`POST /api/admin/mcp-servers/probe`). */
export interface McpProbeResult {
  /** none = answers without credentials; oauth = asks for a sign-in it can describe; key = asks for a credential. */
  auth: 'none' | 'oauth' | 'key' | 'unknown';
  dynamic_registration?: boolean;
  metadata_document?: boolean;
  scopes?: string[];
  tool_count?: number;
  error?: string;
}
