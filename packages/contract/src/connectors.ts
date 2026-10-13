import { z } from 'zod';
import { isoTime } from './common.js';

/** Remote transports only: Greenhouse never starts a local process for a connector. */
export const CONNECTOR_TRANSPORTS = ['streamable_http', 'sse'] as const;
/**
 * Whose credential a call carries: nobody's (`none`), the admin's one key for everyone
 * (`shared`), each member's own key (`per_member`), or each member's sign-in (`oauth`).
 */
export const CONNECTOR_AUTH_MODES = ['none', 'shared', 'per_member', 'oauth'] as const;
export type ConnectorAuthMode = (typeof CONNECTOR_AUTH_MODES)[number];
export const CONNECTION_KINDS = ['connector', 'feishu', 'wecom', 'email'] as const;
export const CONNECTION_STATUSES = ['active', 'needs_reauth', 'error'] as const;

/** What the model calls a connector in mcp_call: short, lowercase, and never renamed. */
export const CONNECTOR_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** A header name (RFC 9110 token characters). */
export const AUTH_HEADER_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** A query parameter that carries a key (`key`, `api_key`, …). */
export const AUTH_QUERY_PARAM_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

const slugSchema = z.string().trim().regex(CONNECTOR_SLUG_PATTERN, {
  message: 'Use a lowercase letter, then letters, digits, "-" or "_" (at most 32).',
});
const toolNamesSchema = z.array(z.string().trim().min(1).max(200)).max(500);
const oneLine = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/[\r\n]/.test(value), { message: 'Use one line.' });
/** A key someone pasted: a trailing newline is dropped, and a line break inside is refused. */
const keySchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !/[\r\n]/.test(value), { message: 'Use one line.' });

/** One tool of a connector, as its server advertised it at the last refresh. */
export const connectorToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
  /** The server says it only reads (readOnlyHint). */
  declared_read_only: z.boolean(),
  /** The server says it may destroy data (destructiveHint). */
  destructive: z.boolean(),
  /** Agents may call it: no allowlist, or on it. */
  allowed: z.boolean(),
  /** Runs without the member's approval: declared read-only, or vouched and not destructive. */
  read_only: z.boolean(),
});
export type ConnectorTool = z.infer<typeof connectorToolSchema>;

/** 管理 → 连接器: an installed connector. Its shared key and OAuth client secret never leave the server. */
export const connectorSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  url: z.string(),
  transport: z.enum(CONNECTOR_TRANSPORTS),
  auth_mode: z.enum(CONNECTOR_AUTH_MODES),
  auth_header: z.string().nullable(),
  auth_query_param: z.string().nullable(),
  auth_prefix: z.string().nullable(),
  /** Whether a shared key is stored. */
  shared_key_set: z.boolean(),
  key_help: z.string(),
  key_help_url: z.string().nullable(),
  oauth_scope: z.string().nullable(),
  /** The client this workspace uses at the server's sign-in: registered by itself, or entered by an admin. */
  oauth_client: z
    .object({ source: z.enum(['dynamic', 'manual']), client_id: z.string(), secret_set: z.boolean() })
    .nullable(),
  enabled: z.boolean(),
  /** null: every tool. */
  allowed_tools: z.array(z.string()).nullable(),
  read_only_tools: z.array(z.string()),
  catalog_id: z.string().nullable(),
  tools: z.array(connectorToolSchema),
  tools_refreshed_at: isoTime.nullable(),
  last_error: z.string().nullable(),
  /** Members who connected their own key or account. */
  connection_count: z.number().int(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type Connector = z.infer<typeof connectorSchema>;

/** Settings an admin edits. Keys and client secrets are write-only: omitted keeps them, '' clears them. */
const connectorFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  url: z.string().trim().url().max(2000),
  transport: z.enum(CONNECTOR_TRANSPORTS),
  auth_mode: z.enum(CONNECTOR_AUTH_MODES),
  auth_header: z.string().trim().regex(AUTH_HEADER_PATTERN).nullable(),
  auth_query_param: z.string().trim().regex(AUTH_QUERY_PARAM_PATTERN).nullable(),
  /** Not trimmed: `Bearer ` ends in the space before the key. */
  auth_prefix: oneLine(32).nullable(),
  shared_key: z.union([z.literal(''), keySchema]),
  key_help: z.string().trim().max(500),
  key_help_url: z.string().trim().url().max(2000).nullable(),
  oauth_scope: oneLine(512).nullable(),
  /** A client an admin registered at the provider by hand (one without dynamic registration). null clears it. */
  oauth_client_id: z.string().trim().min(1).max(512).nullable(),
  oauth_client_secret: z.union([z.literal(''), keySchema]),
  allowed_tools: toolNamesSchema.nullable(),
  read_only_tools: toolNamesSchema,
  enabled: z.boolean(),
};

/** Install from the built-in catalog (its id, and a slug when the suggested one is taken), or from a URL. */
export const createConnectorInputSchema = z.union([
  z.object({ catalog_id: z.string().trim().min(1).max(200), slug: slugSchema.optional() }).strict(),
  z
    .object({ slug: slugSchema, ...connectorFields })
    .partial()
    .required({ slug: true, name: true, url: true })
    .strict(),
]);
export type CreateConnectorInput = z.input<typeof createConnectorInputSchema>;

/** Changes; the slug never changes. A new address or auth mode disconnects every member. */
export const updateConnectorInputSchema = z.object(connectorFields).partial().strict();
export type UpdateConnectorInput = z.input<typeof updateConnectorInputSchema>;

/** A test: connect and list the tools, without changing the cached list. */
export const connectorTestSchema = z.object({
  ok: z.boolean(),
  latency_ms: z.number().int(),
  tool_count: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type ConnectorTest = z.infer<typeof connectorTestSchema>;

export const CONNECTOR_CATEGORIES = ['docs', 'dev', 'productivity', 'data', 'maps', 'search', 'other'] as const;
export const CATALOG_VERIFICATION_LEVELS = ['call', 'sign_in', 'handshake'] as const;

/** One entry of the built-in catalog (`connectors/*.json`). */
export const catalogEntrySchema = z.object({
  /** Its name in the official MCP Registry style, e.g. `app.linear/linear`. */
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  title_zh: z.string().nullable(),
  description: z.string(),
  description_zh: z.string(),
  category: z.enum(CONNECTOR_CATEGORIES),
  website_url: z.string().nullable(),
  icon_url: z.string().nullable(),
  url: z.string(),
  transport: z.enum(CONNECTOR_TRANSPORTS),
  auth: z.object({
    mode: z.enum(CONNECTOR_AUTH_MODES),
    header: z.string().nullable(),
    query_param: z.string().nullable(),
    prefix: z.string().nullable(),
    help: z.string().nullable(),
    help_zh: z.string().nullable(),
    help_url: z.string().nullable(),
    scope: z.string().nullable(),
    /** Members can connect without the admin registering anything at the provider. */
    zero_config: z.boolean(),
  }),
  read_only_tools: z.array(z.string()),
  /** How far it was checked against the live server. */
  verification: z.object({
    level: z.enum(CATALOG_VERIFICATION_LEVELS),
    date: z.string(),
    notes: z.string().nullable(),
  }),
  /** The slug it is installed under here, if it is. */
  installed_slug: z.string().nullable(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const registryQuerySchema = z.object({ q: z.string().trim().max(100).default('') });

/** A remote server found in the official MCP Registry: unvetted, installed through the URL form. */
export const registryResultSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  version: z.string(),
  website_url: z.string().nullable(),
  remotes: z.array(
    z.object({
      transport: z.enum(CONNECTOR_TRANSPORTS),
      url: z.string(),
      headers: z.array(
        z.object({ name: z.string(), description: z.string().nullable(), required: z.boolean(), secret: z.boolean() }),
      ),
    }),
  ),
  /** Set when the same server is in the built-in catalog: install that instead. */
  catalog_id: z.string().nullable(),
});
export type RegistryResult = z.infer<typeof registryResultSchema>;

export const probeInputSchema = z.object({
  url: z.string().trim().url().max(2000),
  transport: z.enum(CONNECTOR_TRANSPORTS).default('streamable_http'),
});

/** What an address asks for before it is installed. */
export const probeResultSchema = z.object({
  /** none: answers without credentials; oauth: asks for a sign-in it describes; key: asks for a key. */
  auth: z.enum(['none', 'oauth', 'key', 'unknown']),
  /** For oauth: whether this workspace can register itself (otherwise an admin enters a client). */
  dynamic_registration: z.boolean().nullable(),
  scopes: z.array(z.string()),
  tool_count: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;

/** A member's external account. Tokens, keys and passwords never leave the server. */
export const connectionSchema = z.object({
  id: z.string(),
  kind: z.enum(CONNECTION_KINDS),
  /** For kind `connector`. */
  connector: z.object({ id: z.string(), slug: z.string(), name: z.string(), enabled: z.boolean() }).nullable(),
  display_name: z.string(),
  status: z.enum(CONNECTION_STATUSES),
  last_error: z.string().nullable(),
  last_verified_at: isoTime.nullable(),
  scopes: z.array(z.string()),
  /** When the access token runs out; it is refreshed when used. */
  expires_at: isoTime.nullable(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type Connection = z.infer<typeof connectionSchema>;

/** An enabled connector as a member sees it. */
export const availableConnectorSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  auth_mode: z.enum(CONNECTOR_AUTH_MODES),
  /** per_member and oauth: each member connects their own key or account first. */
  needs_connection: z.boolean(),
  key_help: z.string(),
  key_help_url: z.string().nullable(),
  tool_count: z.number().int(),
  read_only_tool_count: z.number().int(),
});
export type AvailableConnector = z.infer<typeof availableConnectorSchema>;

/** 设置 → 连接: my connections (all of them, a disabled connector's too) and the connectors I can use. */
export const myConnectionsSchema = z.object({
  items: z.array(connectionSchema),
  connectors: z.array(availableConnectorSchema),
});
export type MyConnections = z.infer<typeof myConnectionsSchema>;

/** Connect my own key to a per_member connector; it is checked against the server first. */
export const connectKeyInputSchema = z.object({
  kind: z.literal('connector').default('connector'),
  connector_id: z.string().min(1).max(64),
  key: keySchema,
});
export type ConnectKeyInput = z.input<typeof connectKeyInputSchema>;

export const oauthStartInputSchema = z.object({ connector_id: z.string().min(1).max(64) });

/** Open this address; the provider sends the browser back to the web app, which finishes the sign-in. */
export const oauthStartSchema = z.object({ authorization_url: z.string(), expires_at: isoTime });
export type OAuthStart = z.infer<typeof oauthStartSchema>;

/** What the callback handed the web app (`oauth_state`, `oauth_code`); only the member who started it can finish. */
export const oauthFinishInputSchema = z.object({
  state: z.string().min(1).max(4096),
  code: z.string().min(1).max(4096),
});
export type OAuthFinishInput = z.input<typeof oauthFinishInputSchema>;

export const connectionTestSchema = z.object({
  ok: z.boolean(),
  tool_count: z.number().int().nullable(),
  error: z.string().nullable(),
  connection: connectionSchema,
});
export type ConnectionTest = z.infer<typeof connectionTestSchema>;
