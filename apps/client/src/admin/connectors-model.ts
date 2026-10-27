/**
 * Team connector form rules (React-free, tested): the editable draft of a connector or catalog
 * entry, and the write body it becomes — secrets only when typed, fields of other sign-in kinds
 * cleared, the handle fixed after creation (packages/types/src/connectors.ts is the server's).
 */

export type ConnectorAuthMode = 'none' | 'shared' | 'per_member';
export type ConnectorAuthKind = 'key' | 'oauth';
export type ConnectorTransport = 'streamable_http' | 'sse';
export type ConnectorStatus = 'not_needed' | 'not_connected' | 'connected' | 'needs_reauth' | 'error';

export interface ConnectorTool {
  name: string;
  description?: string | null;
  read_only?: boolean;
  destructive?: boolean;
  kind: 'read' | 'write' | 'destructive';
  enabled: boolean;
  vouched: boolean;
}

export interface TeamConnector {
  id: string;
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
  has_shared_secret: boolean;
  oauth_client: { source: string; client_id: string; has_secret: boolean } | null;
  oauth_scope: string | null;
  private_network: boolean;
  allow_external_writes: boolean;
  tools: ConnectorTool[];
  tools_refreshed_at: string | null;
  last_error: string | null;
  enabled: boolean;
  catalog_id: string | null;
  connection_count: number;
  status: ConnectorStatus;
}

export interface CatalogEntry {
  id: string;
  slug: string;
  title: string;
  title_zh: string | null;
  description: string;
  description_zh: string;
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
    scope?: string;
  };
  installed_slug?: string | null;
}

export interface ProbeResult {
  auth: 'none' | 'oauth' | 'key' | 'unknown';
  dynamic_registration?: boolean;
  metadata_document?: boolean;
  tool_count?: number;
  error?: string;
}

export const SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export interface Draft {
  slug: string;
  name: string;
  description: string;
  url: string;
  transport: ConnectorTransport;
  auth_mode: ConnectorAuthMode;
  auth_kind: ConnectorAuthKind;
  auth_place: 'header' | 'query';
  auth_header: string;
  auth_query_param: string;
  auth_value_prefix: string;
  shared_secret: string;
  oauth_scope: string;
  oauth_client_id: string;
  oauth_client_secret: string;
  private_network: boolean;
  allow_external_writes: boolean;
  enabled: boolean;
  catalog_id: string | null;
}

export function draftFrom(existing?: TeamConnector, entry?: CatalogEntry, zh = false): Draft {
  if (existing)
    return {
      slug: existing.slug,
      name: existing.name,
      description: existing.description ?? '',
      url: existing.url,
      transport: existing.transport,
      auth_mode: existing.auth_mode,
      auth_kind: existing.auth_kind ?? 'key',
      auth_place: existing.auth_query_param ? 'query' : 'header',
      auth_header: existing.auth_header ?? 'Authorization',
      auth_query_param: existing.auth_query_param ?? '',
      auth_value_prefix: existing.auth_value_prefix ?? '',
      shared_secret: '',
      oauth_scope: existing.oauth_scope ?? '',
      oauth_client_id: existing.oauth_client?.source === 'manual' ? existing.oauth_client.client_id : '',
      oauth_client_secret: '',
      private_network: existing.private_network,
      allow_external_writes: existing.allow_external_writes,
      enabled: existing.enabled,
      catalog_id: existing.catalog_id,
    };
  return {
    slug: entry?.slug ?? '',
    name: entry ? ((zh ? entry.title_zh : null) ?? entry.title) : '',
    description: entry ? (zh ? entry.description_zh : entry.description) : '',
    url: entry?.url ?? '',
    transport: entry?.transport ?? 'streamable_http',
    auth_mode: entry?.auth.mode ?? 'none',
    auth_kind: entry?.auth.kind ?? 'key',
    auth_place: entry?.auth.query_param ? 'query' : 'header',
    auth_header: entry?.auth.header ?? 'Authorization',
    auth_query_param: entry?.auth.query_param ?? '',
    auth_value_prefix: entry?.auth.prefix ?? (entry?.auth.header ? '' : 'Bearer '),
    shared_secret: '',
    oauth_scope: entry?.auth.scope ?? '',
    oauth_client_id: '',
    oauth_client_secret: '',
    private_network: false,
    allow_external_writes: false,
    enabled: true,
    catalog_id: entry?.id ?? null,
  };
}

/** The create body (an update sends the same without `slug`). */
export function connectorInput(d: Draft): Record<string, unknown> {
  const key = d.auth_mode !== 'none' && d.auth_kind === 'key';
  const oauth = d.auth_mode !== 'none' && d.auth_kind === 'oauth';
  return {
    slug: d.slug.trim(),
    name: d.name.trim(),
    description: d.description.trim() || null,
    url: d.url.trim(),
    transport: d.transport,
    auth_mode: d.auth_mode,
    auth_kind: d.auth_mode === 'none' ? null : d.auth_kind,
    auth_header: key && d.auth_place === 'header' ? d.auth_header.trim() || null : null,
    auth_query_param: key && d.auth_place === 'query' ? d.auth_query_param.trim() || null : null,
    auth_value_prefix: key ? d.auth_value_prefix || null : null,
    ...(key && d.auth_mode === 'shared' && d.shared_secret ? { shared_secret: d.shared_secret } : {}),
    oauth_scope: oauth ? d.oauth_scope.trim() || null : null,
    oauth_client_id: oauth ? d.oauth_client_id.trim() || null : null,
    ...(oauth && d.oauth_client_secret ? { oauth_client_secret: d.oauth_client_secret } : {}),
    private_network: d.private_network,
    allow_external_writes: d.allow_external_writes,
    enabled: d.enabled,
    catalog_id: d.catalog_id,
  };
}

/** A new handle must match the pattern; an existing one is fixed. */
export const draftReady = (d: Draft, existing: boolean) =>
  !!d.name.trim() && !!d.url.trim() && (existing || SLUG_PATTERN.test(d.slug.trim()));

/** Saving this edit drops every member's stored credential (a new address or sign-in method). */
export const dropsCredentials = (existing: TeamConnector, d: Draft) =>
  existing.url !== d.url.trim() || existing.auth_mode !== d.auth_mode;

/** The tool switches as the PATCH writes them. */
export function toolPolicy(tools: readonly ConnectorTool[]) {
  return {
    tool_policy: Object.fromEntries(tools.map((tool) => [tool.name, tool.enabled ? 'on' : 'off'])),
    vouched_read_only: tools.filter((tool) => tool.vouched).map((tool) => tool.name),
  };
}

/** How a tool reads in the switch list: vouched tools count as reads. */
export const toolKind = (tool: ConnectorTool): 'read' | 'write' | 'destructive' =>
  tool.read_only || tool.vouched ? 'read' : tool.destructive ? 'destructive' : 'write';
