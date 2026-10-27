/**
 * MCP connectors — the CLIENT side of MCP (Greenhouse calling remote MCP servers).
 *
 * Not to be confused with `@greenhouse/types/mcp`, which carves up Greenhouse's
 * own `/api/mcp` SERVER surface for consent. A connector is a remote MCP server
 * whose tools members' agents reach through the one gateway tool `mcp_call`.
 *
 * - Team connectors are configured by a super; every team / super member uses
 *   them. `shared` carries one team credential, `per_member` has each member
 *   connect their own account, `none` sends nothing.
 * - Personal connectors belong to one member and only they use them; their
 *   handle is `me/<slug>`, so they never collide with a team slug.
 *
 * Shared by the API (validation, views), the web pages (forms) and the mobile
 * app (vendored copy of the view types), so they cannot disagree about what a
 * valid entry is.
 */

export const CONNECTOR_SCOPES = ['team', 'personal'] as const;
export type ConnectorScope = (typeof CONNECTOR_SCOPES)[number];

/** Remote transports only — a stdio server would be arbitrary code in the API process. */
export const CONNECTOR_TRANSPORTS = ['streamable_http', 'sse'] as const;
export type ConnectorTransport = (typeof CONNECTOR_TRANSPORTS)[number];

/**
 * Whose credential a call carries:
 * - `none`       — nothing is sent;
 * - `shared`     — one team credential (a key, or an OAuth sign-in a super made);
 * - `per_member` — each member's own key or OAuth sign-in.
 * A personal connector is `none` or `per_member` (the owner's own credential).
 */
export const CONNECTOR_AUTH_MODES = ['none', 'shared', 'per_member'] as const;
export type ConnectorAuthMode = (typeof CONNECTOR_AUTH_MODES)[number];

/** What the credential is: a pasted key, or an OAuth 2.1 sign-in (MCP authorization spec). */
export const CONNECTOR_AUTH_KINDS = ['key', 'oauth'] as const;
export type ConnectorAuthKind = (typeof CONNECTOR_AUTH_KINDS)[number];

export const CONNECTOR_TOOL_POLICIES = ['on', 'off'] as const;
export type ConnectorToolPolicy = (typeof CONNECTOR_TOOL_POLICIES)[number];

/** The model-facing handle of a personal connector is this prefix plus its slug. */
export const PERSONAL_CONNECTOR_PREFIX = 'me/';

/** Lowercase, short and stable: renaming would break every saved instruction that names it. */
export const CONNECTOR_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const CONNECTOR_NAME_MAX = 80;
export const CONNECTOR_DESCRIPTION_MAX = 500;
export const CONNECTOR_OAUTH_SCOPE_MAX = 512;
export const CONNECTOR_AUTH_PREFIX_MAX = 32;
export const CONNECTOR_SECRET_MAX = 4096;
/** Header names per RFC 7230 token characters. */
export const CONNECTOR_AUTH_HEADER_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** A query parameter that carries a key (`key`, `api_key`, …). */
export const CONNECTOR_AUTH_QUERY_PARAM_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
/** Remote tool names a call may carry (MCP spec SEP-986 shape, generous length). */
export const CONNECTOR_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.\-/]{1,128}$/;

/** One tool as the server advertised it at the last refresh. */
export interface ConnectorTool {
  name: string;
  description: string;
  /** The tool's JSON Schema for its arguments, as advertised. */
  input_schema: Record<string, unknown>;
  /** Server-declared `readOnlyHint`. */
  read_only: boolean;
  /** Server-declared `destructiveHint` (explicitly true). */
  destructive: boolean;
}

/** How a tool behaves for the agent: reads run, writes run when switched on, destructive ones preview first. */
export type ConnectorToolKind = 'read' | 'write' | 'destructive';

/**
 * Read-only when the server says so, or when an admin (or the catalog) vouched
 * for it — unless the server itself calls it destructive.
 */
export function isConnectorToolReadOnly(
  tool: Pick<ConnectorTool, 'name' | 'read_only' | 'destructive'>,
  vouched: readonly string[] | null | undefined,
): boolean {
  if (tool.read_only) return true;
  return !tool.destructive && Boolean(vouched?.includes(tool.name));
}

export function connectorToolKind(
  tool: Pick<ConnectorTool, 'name' | 'read_only' | 'destructive'>,
  vouched: readonly string[] | null | undefined,
): ConnectorToolKind {
  if (isConnectorToolReadOnly(tool, vouched)) return 'read';
  return tool.destructive ? 'destructive' : 'write';
}

/**
 * Whether members' agents may call a tool: the stored switch, else the default —
 * read-only tools on, everything else off until someone turns it on.
 */
export function isConnectorToolEnabled(
  tool: Pick<ConnectorTool, 'name' | 'read_only' | 'destructive'>,
  policy: Readonly<Record<string, string>> | null | undefined,
  vouched: readonly string[] | null | undefined,
): boolean {
  const stored = policy?.[tool.name];
  if (stored === 'on') return true;
  if (stored === 'off') return false;
  return isConnectorToolReadOnly(tool, vouched);
}

/** The handle the model passes as `connector`. */
export function connectorHandle(row: { scope: ConnectorScope; slug: string }): string {
  return row.scope === 'personal' ? `${PERSONAL_CONNECTOR_PREFIX}${row.slug}` : row.slug;
}

/** How the instance identifies itself to a server's OAuth authorization server. */
export type ConnectorOAuthClientSource = 'dynamic' | 'metadata_document' | 'manual';

/** One tool in an admin / owner view: the advertisement plus its switch and kind. */
export interface ConnectorToolView extends ConnectorTool {
  kind: ConnectorToolKind;
  enabled: boolean;
  /** Read-only because an admin vouched for it (not the server). */
  vouched: boolean;
}

/**
 * A member's standing with a connector:
 * - `not_needed`    — none / shared: nothing to connect;
 * - `not_connected` — per_member without a credential of theirs;
 * - `connected`     — their key or sign-in is stored;
 * - `needs_reauth`  — their sign-in stopped working; reconnect;
 * - `error`         — the server refused their credential.
 */
export type ConnectorConnectionStatus = 'not_needed' | 'not_connected' | 'connected' | 'needs_reauth' | 'error';

/** What the admin API and an owner's personal-connector API return — never a credential or client secret. */
export interface ConnectorView {
  id: string;
  scope: ConnectorScope;
  /** Personal connectors only. */
  owner_user_id: string | null;
  slug: string;
  handle: string;
  name: string;
  description: string | null;
  url: string;
  transport: ConnectorTransport;
  auth_mode: ConnectorAuthMode;
  auth_kind: ConnectorAuthKind | null;
  auth_header: string | null;
  auth_query_param: string | null;
  auth_value_prefix: string | null;
  /** A shared key, or the shared OAuth sign-in, is stored (the value never leaves the server). */
  has_shared_secret: boolean;
  oauth_client: { source: ConnectorOAuthClientSource; client_id: string; has_secret: boolean } | null;
  oauth_scope: string | null;
  private_network: boolean;
  allow_external_writes: boolean;
  tools: ConnectorToolView[];
  tools_refreshed_at: string | null;
  last_error: string | null;
  enabled: boolean;
  catalog_id: string | null;
  /** Members holding a connection (per_member). */
  connection_count: number;
  /** The caller's own standing (personal per_member connectors: the owner's). */
  status: ConnectorConnectionStatus;
  created_at: string;
  updated_at: string;
}

/** A team connector as a member sees it (Settings → Connections, mobile 我 → 连接). */
export interface ConnectorMemberView {
  id: string;
  scope: ConnectorScope;
  slug: string;
  handle: string;
  name: string;
  description: string | null;
  auth_mode: ConnectorAuthMode;
  auth_kind: ConnectorAuthKind | null;
  catalog_id: string | null;
  tool_count: number;
  status: ConnectorConnectionStatus;
  connected_at: string | null;
  error: string | null;
}

/** Fields an admin (team) or a member (personal) writes. Secrets are write-only. */
export interface ConnectorInput {
  slug: string;
  name: string;
  description?: string | null;
  url: string;
  transport?: ConnectorTransport;
  auth_mode?: ConnectorAuthMode;
  auth_kind?: ConnectorAuthKind | null;
  auth_header?: string | null;
  auth_query_param?: string | null;
  auth_value_prefix?: string | null;
  /** Write-only shared key (team `shared` + `key`). Omitted on update = keep; '' = clear. */
  shared_secret?: string;
  oauth_scope?: string | null;
  /** A client registered by hand at the provider (servers without dynamic registration). */
  oauth_client_id?: string | null;
  /** Write-only. Omitted = keep; '' = clear. */
  oauth_client_secret?: string;
  private_network?: boolean;
  allow_external_writes?: boolean;
  enabled?: boolean;
  tool_policy?: Record<string, ConnectorToolPolicy>;
  vouched_read_only?: string[];
  catalog_id?: string | null;
}

export type ConnectorUpdate = Partial<Omit<ConnectorInput, 'slug'>>;

function httpUrl(raw: unknown): URL | null {
  try {
    const url = new URL(String(raw ?? ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function isNameList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 500 &&
    value.every((t) => typeof t === 'string' && CONNECTOR_TOOL_NAME_PATTERN.test(t))
  );
}

function isPolicyMap(value: unknown): value is Record<string, ConnectorToolPolicy> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.length <= 500 &&
    entries.every(([name, v]) => CONNECTOR_TOOL_NAME_PATTERN.test(name) && (v === 'on' || v === 'off'))
  );
}

/** Shape-check an entry field by field; returns the first problem in words a person can act on. */
export function validateConnectorInput(
  input: Partial<ConnectorInput>,
  opts: { partial?: boolean } = {},
): string | null {
  const need = (key: keyof ConnectorInput) => !opts.partial || input[key] !== undefined;

  if (need('slug') && (typeof input.slug !== 'string' || !CONNECTOR_SLUG_PATTERN.test(input.slug))) {
    return 'slug must start with a lowercase letter and use only a-z, 0-9, "-" or "_" (max 32)';
  }
  if (need('name')) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > CONNECTOR_NAME_MAX) return `name is required (max ${CONNECTOR_NAME_MAX} characters)`;
  }
  if (input.description != null) {
    if (typeof input.description !== 'string' || input.description.length > CONNECTOR_DESCRIPTION_MAX) {
      return `description must be ${CONNECTOR_DESCRIPTION_MAX} characters or fewer`;
    }
  }
  if (need('url')) {
    const url = httpUrl(input.url);
    if (!url) return 'url must be the http(s) address of the MCP endpoint (for example "https://example.com/mcp")';
    if (url.username || url.password) return 'put credentials in the key settings, never in the address';
    if (url.hash) return 'the address must not contain a #fragment';
  }
  if (input.transport !== undefined && !CONNECTOR_TRANSPORTS.includes(input.transport)) {
    return `transport must be one of ${CONNECTOR_TRANSPORTS.map((t) => `"${t}"`).join(', ')}`;
  }
  if (input.auth_mode !== undefined && !CONNECTOR_AUTH_MODES.includes(input.auth_mode)) {
    return `auth_mode must be one of ${CONNECTOR_AUTH_MODES.map((m) => `"${m}"`).join(', ')}`;
  }
  if (input.auth_kind != null && !CONNECTOR_AUTH_KINDS.includes(input.auth_kind)) {
    return 'auth_kind must be "key" or "oauth"';
  }
  if (input.auth_header && !CONNECTOR_AUTH_HEADER_PATTERN.test(input.auth_header)) {
    return 'auth_header must be a plain HTTP header name (for example "Authorization")';
  }
  if (input.auth_query_param && !CONNECTOR_AUTH_QUERY_PARAM_PATTERN.test(input.auth_query_param)) {
    return 'auth_query_param must be a plain query parameter name (for example "key")';
  }
  if (input.auth_header && input.auth_query_param) {
    return 'send the key either in a header or in a query parameter, not both';
  }
  if (input.auth_value_prefix != null) {
    if (input.auth_value_prefix.length > CONNECTOR_AUTH_PREFIX_MAX || /[\r\n]/.test(input.auth_value_prefix)) {
      return `auth_value_prefix must be one line of at most ${CONNECTOR_AUTH_PREFIX_MAX} characters (for example "Bearer ")`;
    }
  }
  if (input.shared_secret !== undefined) {
    if (typeof input.shared_secret !== 'string' || input.shared_secret.length > CONNECTOR_SECRET_MAX) {
      return `the key must be at most ${CONNECTOR_SECRET_MAX} characters`;
    }
    if (/[\r\n]/.test(input.shared_secret)) return 'the key must be one line';
  }
  if (input.oauth_scope != null) {
    if (input.oauth_scope.length > CONNECTOR_OAUTH_SCOPE_MAX || /[\r\n"\\]/.test(input.oauth_scope)) {
      return `oauth_scope must be space-separated scopes, at most ${CONNECTOR_OAUTH_SCOPE_MAX} characters`;
    }
  }
  if (input.oauth_client_id != null && (input.oauth_client_id.length > 512 || /\s/.test(input.oauth_client_id))) {
    return 'oauth_client_id must be the client id the authorization server issued (no spaces)';
  }
  if (input.oauth_client_secret !== undefined && input.oauth_client_secret.length > CONNECTOR_SECRET_MAX) {
    return 'oauth_client_secret is too long';
  }
  if (input.tool_policy !== undefined && !isPolicyMap(input.tool_policy)) {
    return 'tool_policy must map tool names to "on" or "off"';
  }
  if (input.vouched_read_only !== undefined && !isNameList(input.vouched_read_only)) {
    return 'vouched_read_only must be a list of tool names';
  }
  if (input.catalog_id != null && (typeof input.catalog_id !== 'string' || input.catalog_id.length > 200)) {
    return 'catalog_id is invalid';
  }
  return null;
}

/** The settings that decide how a call authenticates, after an update is merged onto the row. */
export interface ConnectorAuthConfig {
  scope: ConnectorScope;
  auth_mode: ConnectorAuthMode;
  auth_kind: ConnectorAuthKind | null;
  auth_header: string | null;
  auth_query_param: string | null;
  /** A shared KEY is stored (not an OAuth sign-in). */
  has_shared_key: boolean;
  private_network: boolean;
}

/**
 * The cross-field rules a merged configuration must satisfy — checked after the
 * per-field shape check, because a partial update can only be judged together
 * with what is already stored.
 */
export function validateConnectorAuthConfig(config: ConnectorAuthConfig): string | null {
  const placed = Boolean(config.auth_header || config.auth_query_param);
  if (config.scope === 'personal') {
    if (config.auth_mode === 'shared') return 'a personal connector uses your own key or sign-in, not a shared one';
    if (config.private_network) return 'only a team connector may point into the private network';
  }
  switch (config.auth_mode) {
    case 'none':
      if (config.auth_kind) return 'a connector without sign-in has no auth kind';
      if (config.has_shared_key) return 'a connector without sign-in stores no key — clear it';
      return null;
    case 'shared':
      if (config.auth_kind === 'key') {
        if (!config.has_shared_key) return 'a shared key connector needs the key every member will use';
        if (!placed) return 'say where the key goes: a header name or a query parameter';
        return null;
      }
      if (config.auth_kind === 'oauth') {
        if (config.has_shared_key) return 'a shared sign-in stores no key — clear it';
        return null;
      }
      return 'a shared connector needs an auth kind: "key" or "oauth"';
    case 'per_member':
      if (config.has_shared_key) return "each member brings their own credential — don't store a shared key";
      if (config.auth_kind === 'key') {
        if (!placed) return "say where each member's key goes: a header name or a query parameter";
        return null;
      }
      if (config.auth_kind === 'oauth') return null;
      return 'a per-member connector needs an auth kind: "key" or "oauth"';
  }
}

/** `mcp_call`'s answer when the member has to connect first — chat renders a "Connect" card from it. */
export interface ConnectorNeedsConnection {
  needs_connection: true;
  connector: string;
  connector_id: string;
  connector_name: string;
  auth_kind: ConnectorAuthKind;
  reason: 'not_connected' | 'needs_reauth';
  error: string;
}

export function isConnectorNeedsConnection(value: unknown): value is ConnectorNeedsConnection {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.needs_connection === true && typeof v.connector === 'string' && typeof v.connector_id === 'string';
}

/** The message the OAuth finish page posts to the window that opened it. */
export const CONNECTOR_CONNECT_MESSAGE_TYPE = 'greenhouse:connector';
export interface ConnectorConnectMessage {
  type: typeof CONNECTOR_CONNECT_MESSAGE_TYPE;
  connector_id: string;
  ok: boolean;
}

/**
 * The classic web app's finish route. The public OAuth callback now returns browsers to the universal
 * client (`CLIENT_ROUTES.connectorFinish`, ./client-routes.ts); this stays until the classic app goes.
 */
export const CONNECTOR_OAUTH_FINISH_HASH = '#/connectors/oauth-finish';

// ─── The official connector catalog (`connectors/*.json`) ───

/** The `_meta` key under which a catalog file keeps Greenhouse's own fields (reverse-DNS, per the Registry convention). */
export const CONNECTOR_CATALOG_META_KEY = 'com.linjiejim.greenhouse/connector';

export const CONNECTOR_CATEGORIES = ['docs', 'dev', 'productivity', 'data', 'maps', 'search', 'other'] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

/**
 * How far a catalog entry was verified against the live server:
 * `call` — connected and called a tool; `sign_in` — OAuth up to the provider's
 * consent page; `handshake` — the server answered, calling it needs a key.
 */
export const CONNECTOR_VERIFICATION_LEVELS = ['call', 'sign_in', 'handshake'] as const;
export type ConnectorVerificationLevel = (typeof CONNECTOR_VERIFICATION_LEVELS)[number];

/** One catalog entry as the admin API serves it. */
export interface ConnectorCatalogEntry {
  /** The server's name in the official MCP Registry style (`app.linear/linear`). */
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
  transport: ConnectorTransport;
  auth: {
    mode: ConnectorAuthMode;
    kind: ConnectorAuthKind | null;
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
  /** The slug it is installed under as a team connector on this instance, if it is. */
  installed_slug?: string | null;
}

/** What an address asks for before it is saved (`POST …/connectors/probe`). */
export interface ConnectorProbeResult {
  /** none = answers without credentials; oauth = asks for a sign-in it can describe; key = asks for a credential. */
  auth: 'none' | 'oauth' | 'key' | 'unknown';
  dynamic_registration?: boolean;
  metadata_document?: boolean;
  scopes?: string[];
  tool_count?: number;
  error?: string;
}
