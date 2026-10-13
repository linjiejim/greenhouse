/**
 * The connector form of 管理 → 连接器: the draft an admin edits, what is wrong with it before it
 * is sent, and the body it becomes. An edit sends only what changed (a new address or auth mode
 * disconnects every member). The tool switches turn into the allowlist and the vouched
 * read-only list, and the connector can be redrawn from those lists before the server answers.
 */

import {
  AUTH_HEADER_PATTERN,
  AUTH_QUERY_PARAM_PATTERN,
  CONNECTOR_SLUG_PATTERN,
  type Connector,
  type ConnectorAuthMode,
  type CreateConnectorInput,
  type UpdateConnectorInput,
} from '@greenhouse/contract';
import type { MessageKey } from '../../i18n/zh';

export type KeyPlace = 'header' | 'query';

export interface ConnectorDraft {
  name: string;
  slug: string;
  description: string;
  url: string;
  transport: Connector['transport'];
  auth_mode: ConnectorAuthMode;
  /** Where a key goes (shared and per_member): a header or a query parameter. */
  place: KeyPlace;
  header: string;
  query: string;
  /** Not trimmed: `Bearer ` ends in the space before the key. */
  prefix: string;
  /** The key every call carries, typed when the connector becomes shared; afterwards it is write-only. */
  shared_key: string;
  key_help: string;
  key_help_url: string;
  oauth_scope: string;
  /** A client an admin registered at the provider (one without dynamic registration). */
  oauth_client_id: string;
  /** Its secret, typed on install; afterwards it is write-only. */
  oauth_client_secret: string;
}

export const blankDraft = (): ConnectorDraft => ({
  name: '',
  slug: '',
  description: '',
  url: '',
  transport: 'streamable_http',
  auth_mode: 'none',
  place: 'header',
  header: 'Authorization',
  query: '',
  prefix: '',
  shared_key: '',
  key_help: '',
  key_help_url: '',
  oauth_scope: '',
  oauth_client_id: '',
  oauth_client_secret: '',
});

export function draftOf(connector: Connector): ConnectorDraft {
  return {
    ...blankDraft(),
    name: connector.name,
    slug: connector.slug,
    description: connector.description,
    url: connector.url,
    transport: connector.transport,
    auth_mode: connector.auth_mode,
    place: connector.auth_query_param ? 'query' : 'header',
    header: connector.auth_header ?? 'Authorization',
    query: connector.auth_query_param ?? '',
    prefix: connector.auth_prefix ?? '',
    key_help: connector.key_help,
    key_help_url: connector.key_help_url ?? '',
    oauth_scope: connector.oauth_scope ?? '',
    oauth_client_id: connector.oauth_client?.source === 'manual' ? connector.oauth_client.client_id : '',
  };
}

/** Calls carry a key, so where it goes matters. */
export const carriesKey = (mode: ConnectorAuthMode) => mode === 'shared' || mode === 'per_member';

const toSlug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32)
    .replace(/[-_]+$/, '');

/** The slug a name suggests, else the address's own name (mcp.linear.app → linear); '' when neither has one. */
export function slugFrom(name: string, url = ''): string {
  const fromName = toSlug(name);
  if (fromName) return fromName;
  try {
    const labels = new URL(url).hostname.split('.').filter((label) => !['www', 'mcp', 'api'].includes(label));
    return toSlug(labels.length > 1 ? labels[labels.length - 2]! : (labels[0] ?? ''));
  } catch {
    return '';
  }
}

/** http or https; the server decides which hosts it may reach. */
function isWebAddress(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** The first thing to fix, by field, or null. `before` is the connector being edited (null: a new one). */
export function draftProblem(
  draft: ConnectorDraft,
  before: Connector | null,
): { field: keyof ConnectorDraft; word: MessageKey } | null {
  if (!draft.name.trim()) return { field: 'name', word: 'connectors.needName' };
  if (!before && !CONNECTOR_SLUG_PATTERN.test(draft.slug.trim())) return { field: 'slug', word: 'connectors.badSlug' };
  if (!isWebAddress(draft.url.trim())) return { field: 'url', word: 'connectors.badUrl' };
  if (carriesKey(draft.auth_mode)) {
    if (draft.place === 'header' && !AUTH_HEADER_PATTERN.test(draft.header.trim())) {
      return { field: 'header', word: 'connectors.badHeader' };
    }
    if (draft.place === 'query' && !AUTH_QUERY_PARAM_PATTERN.test(draft.query.trim())) {
      return { field: 'query', word: 'connectors.badQuery' };
    }
    if (draft.prefix.length > 32 || /[\r\n]/.test(draft.prefix))
      return { field: 'prefix', word: 'connectors.badPrefix' };
  }
  if (draft.auth_mode === 'shared' && before?.auth_mode !== 'shared' && !draft.shared_key.trim()) {
    return { field: 'shared_key', word: 'connectors.needSharedKey' };
  }
  if (
    draft.auth_mode === 'per_member' &&
    draft.key_help_url.trim() &&
    !draft.key_help_url.trim().startsWith('https://')
  ) {
    return { field: 'key_help_url', word: 'connectors.badHelpUrl' };
  }
  return null;
}

/** Where the key goes, for a mode that sends one. */
function placement(draft: ConnectorDraft) {
  return {
    auth_header: draft.place === 'header' ? draft.header.trim() : null,
    auth_query_param: draft.place === 'query' ? draft.query.trim() : null,
    auth_prefix: draft.prefix || null,
  };
}

/** Installing from an address. */
export function createInput(draft: ConnectorDraft): CreateConnectorInput {
  const clientId = draft.oauth_client_id.trim();
  return {
    slug: draft.slug.trim(),
    name: draft.name.trim(),
    url: draft.url.trim(),
    transport: draft.transport,
    auth_mode: draft.auth_mode,
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    ...(carriesKey(draft.auth_mode) ? placement(draft) : {}),
    ...(draft.auth_mode === 'shared' ? { shared_key: draft.shared_key.trim() } : {}),
    ...(draft.auth_mode === 'per_member'
      ? { key_help: draft.key_help.trim(), key_help_url: draft.key_help_url.trim() || null }
      : {}),
    ...(draft.auth_mode === 'oauth'
      ? {
          oauth_scope: draft.oauth_scope.trim() || null,
          ...(clientId
            ? {
                oauth_client_id: clientId,
                ...(draft.oauth_client_secret.trim() ? { oauth_client_secret: draft.oauth_client_secret.trim() } : {}),
              }
            : {}),
        }
      : {}),
  };
}

/** What an edit changes; empty when nothing did. */
export function updateInput(draft: ConnectorDraft, connector: Connector): UpdateConnectorInput {
  const before = draftOf(connector);
  const input: UpdateConnectorInput = {};
  if (draft.name.trim() !== before.name) input.name = draft.name.trim();
  if (draft.description.trim() !== before.description) input.description = draft.description.trim();
  if (draft.url.trim() !== before.url) input.url = draft.url.trim();
  if (draft.transport !== before.transport) input.transport = draft.transport;
  if (draft.auth_mode !== before.auth_mode) input.auth_mode = draft.auth_mode;
  if (carriesKey(draft.auth_mode)) {
    const place = placement(draft);
    if (place.auth_header !== connector.auth_header) input.auth_header = place.auth_header;
    if (place.auth_query_param !== connector.auth_query_param) input.auth_query_param = place.auth_query_param;
    if (place.auth_prefix !== connector.auth_prefix) input.auth_prefix = place.auth_prefix;
  }
  if (draft.auth_mode === 'shared' && connector.auth_mode !== 'shared') input.shared_key = draft.shared_key.trim();
  if (draft.auth_mode === 'per_member') {
    if (draft.key_help.trim() !== before.key_help) input.key_help = draft.key_help.trim();
    const helpUrl = draft.key_help_url.trim() || null;
    if (helpUrl !== connector.key_help_url) input.key_help_url = helpUrl;
  }
  if (draft.auth_mode === 'oauth') {
    const scope = draft.oauth_scope.trim() || null;
    if (scope !== connector.oauth_scope) input.oauth_scope = scope;
    const clientId = draft.oauth_client_id.trim() || null;
    if (clientId !== (before.oauth_client_id || null)) input.oauth_client_id = clientId;
  }
  return input;
}

/** A new address or auth mode ends every member's connection. */
export const disconnectsMembers = (input: UpdateConnectorInput) =>
  input.url !== undefined || input.auth_mode !== undefined;

/** Names in the order the server lists the tools, then any it no longer lists. */
function ordered(connector: Pick<Connector, 'tools'>, names: Set<string>): string[] {
  const listed = connector.tools.map((tool) => tool.name).filter((name) => names.has(name));
  return [...listed, ...[...names].filter((name) => !listed.includes(name))];
}

/** The allowlist after one tool is turned on or off. It stays a list; only 全部 brings back null (every tool, new ones too). */
export function allowTool(connector: Pick<Connector, 'tools' | 'allowed_tools'>, name: string, on: boolean): string[] {
  const names = new Set(connector.allowed_tools ?? connector.tools.map((tool) => tool.name));
  if (on) names.add(name);
  else names.delete(name);
  return ordered(connector, names);
}

/** The tools an admin vouched for as read-only, after one is added or taken out. */
export function vouchTool(
  connector: Pick<Connector, 'tools' | 'read_only_tools'>,
  name: string,
  on: boolean,
): string[] {
  const names = new Set(connector.read_only_tools);
  if (on) names.add(name);
  else names.delete(name);
  return ordered(connector, names);
}

/** The connector as the server will show it after this change: each tool follows the lists, as the API decides. */
export function withChange(connector: Connector, change: UpdateConnectorInput): Connector {
  const allowed = change.allowed_tools !== undefined ? change.allowed_tools : connector.allowed_tools;
  const vouched = change.read_only_tools ?? connector.read_only_tools;
  return {
    ...connector,
    enabled: change.enabled ?? connector.enabled,
    allowed_tools: allowed,
    read_only_tools: vouched,
    tools: connector.tools.map((tool) => ({
      ...tool,
      allowed: !allowed || allowed.includes(tool.name),
      read_only: tool.declared_read_only || (!tool.destructive && vouched.includes(tool.name)),
    })),
  };
}
