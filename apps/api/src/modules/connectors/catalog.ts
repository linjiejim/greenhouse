/**
 * The built-in connector catalog and the official MCP Registry.
 *
 * - Catalog: `connectors/*.json` at the repository root. Each file is an official MCP Registry
 *   `server.json` whose `_meta` carries Greenhouse's fields (suggested slug, how members
 *   authenticate, read-only tools the catalog vouches for, how far it was verified). One file is
 *   one contribution; catalog.test.ts validates every file.
 * - Registry: a read-only search of registry.modelcontextprotocol.io for remote servers. It is
 *   slow (tens of seconds) and promises no latency, so answers are cached and time out. Its
 *   servers are unvetted: an admin installs one through the URL form, with nothing vouched read-only.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { discoverOAuthServerInfo, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  AUTH_HEADER_PATTERN,
  AUTH_QUERY_PARAM_PATTERN,
  CATALOG_VERIFICATION_LEVELS,
  CONNECTOR_CATEGORIES,
  CONNECTOR_SLUG_PATTERN,
  type CatalogEntry,
  type ProbeResult,
  type RegistryResult,
} from '@greenhouse/contract';
import type { ConnectorTransport } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { describeError, knock, listTools } from './mcp.js';
import { connectorFetch, type FetchLike, type NetworkMode } from './network.js';

/** The Registry's server.json schema the catalog files declare. */
export const REGISTRY_SERVER_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
export const OFFICIAL_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';
/** The `_meta` key a catalog file keeps Greenhouse's fields under (reverse DNS, as the Registry asks). */
export const CATALOG_META_KEY = 'com.linjiejim.greenhouse/connector';
/** `connectors/` at the repository root. */
export const CATALOG_DIR = fileURLToPath(new URL('../../../../../connectors/', import.meta.url));

/** Measured 2026-10 behind a proxy: a 20-result search took about 28 s. */
export const REGISTRY_TIMEOUT_MS = 45_000;
const REGISTRY_CACHE_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), 'must be an https URL');

const authSchema = z
  .object({
    mode: z.enum(['none', 'per_member', 'oauth']),
    header: z.string().regex(AUTH_HEADER_PATTERN).optional(),
    query_param: z.string().regex(AUTH_QUERY_PARAM_PATTERN).optional(),
    prefix: z.string().max(32).optional(),
    help: z.string().max(500).optional(),
    help_zh: z.string().max(500).optional(),
    help_url: httpsUrl.optional(),
    scope: z.string().max(512).optional(),
    zero_config: z.boolean(),
  })
  .strict()
  .refine((auth) => !(auth.header && auth.query_param), 'auth: a header or a query parameter, not both')
  .refine(
    (auth) => auth.mode !== 'per_member' || Boolean(auth.header || auth.query_param),
    'auth: a per_member entry says where the key goes (header or query_param)',
  )
  .refine(
    (auth) => auth.mode !== 'per_member' || Boolean(auth.help && auth.help_zh),
    'auth: per_member needs help and help_zh',
  );

const metaSchema = z
  .object({
    slug: z.string().regex(CONNECTOR_SLUG_PATTERN),
    category: z.enum(CONNECTOR_CATEGORIES),
    title_zh: z.string().min(1).max(100).optional(),
    description_zh: z.string().min(1).max(500),
    auth: authSchema,
    read_only_tools: z.array(z.string().min(1)).default([]),
    verification: z
      .object({
        level: z.enum(CATALOG_VERIFICATION_LEVELS),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        notes: z.string().max(500).optional(),
      })
      .strict(),
  })
  .strict();

/** One catalog file: a Registry server.json plus Greenhouse's `_meta`. */
export const catalogFileSchema = z
  .object({
    $schema: z.literal(REGISTRY_SERVER_SCHEMA),
    name: z.string().regex(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/, 'name: reverse-DNS namespace / server name'),
    title: z.string().min(1).max(100),
    description: z.string().min(1).max(100),
    version: z.string().min(1).max(255),
    websiteUrl: httpsUrl.optional(),
    icons: z.array(z.object({ src: httpsUrl }).passthrough()).optional(),
    remotes: z.array(z.object({ type: z.enum(['streamable-http', 'sse']), url: httpsUrl }).passthrough()).min(1),
    _meta: z.object({ [CATALOG_META_KEY]: metaSchema }).passthrough(),
  })
  .passthrough();

export type CatalogItem = Omit<CatalogEntry, 'installed_slug'>;

function toEntry(file: z.infer<typeof catalogFileSchema>): CatalogItem {
  const meta = file._meta[CATALOG_META_KEY]!;
  // Streamable HTTP first; legacy SSE only when that is all a server offers.
  const remote = file.remotes.find((entry) => entry.type === 'streamable-http') ?? file.remotes[0]!;
  const auth = meta.auth;
  return {
    id: file.name,
    slug: meta.slug,
    title: file.title,
    title_zh: meta.title_zh ?? null,
    description: file.description,
    description_zh: meta.description_zh,
    category: meta.category,
    website_url: file.websiteUrl ?? null,
    icon_url: file.icons?.[0]?.src ?? null,
    url: remote.url,
    transport: remote.type === 'sse' ? 'sse' : 'streamable_http',
    auth: {
      mode: auth.mode,
      header: auth.header ?? null,
      query_param: auth.query_param ?? null,
      prefix: auth.prefix ?? null,
      help: auth.help ?? null,
      help_zh: auth.help_zh ?? null,
      help_url: auth.help_url ?? null,
      scope: auth.scope ?? null,
      zero_config: auth.zero_config,
    },
    read_only_tools: meta.read_only_tools,
    verification: { ...meta.verification, notes: meta.verification.notes ?? null },
  };
}

/** Every catalog file; a broken one is reported, never half-loaded. */
export function loadCatalog(dir = CATALOG_DIR): { entries: CatalogItem[]; errors: string[] } {
  const entries: CatalogItem[] = [];
  const errors: string[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (error) {
    return { entries, errors: [`could not read ${dir}: ${toErrorMessage(error)}`] };
  }
  for (const name of files.sort()) {
    try {
      const parsed = catalogFileSchema.safeParse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        errors.push(`${name}: ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`);
        continue;
      }
      entries.push(toEntry(parsed.data));
    } catch (error) {
      errors.push(`${name}: ${toErrorMessage(error)}`);
    }
  }
  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) errors.push(`duplicate catalog id "${entry.id}"`);
    if (slugs.has(entry.slug)) errors.push(`duplicate slug "${entry.slug}"`);
    ids.add(entry.id);
    slugs.add(entry.slug);
  }
  return { entries, errors };
}

/** The catalog, read once per process (it ships with the code). */
export function catalogReader(dir = CATALOG_DIR): () => CatalogItem[] {
  let cached: CatalogItem[] | null = null;
  return () => {
    if (!cached) {
      const { entries, errors } = loadCatalog(dir);
      for (const error of errors) logger.warn('[connectors] skipped a catalog file', { error });
      cached = entries;
    }
    return cached;
  };
}

// ─── the official MCP Registry ───────────────────────────

interface RegistryItem {
  server?: {
    name?: string;
    title?: string;
    description?: string;
    version?: string;
    websiteUrl?: string;
    remotes?: Array<{
      type?: string;
      url?: string;
      headers?: Array<{ name?: string; description?: string; isRequired?: boolean; isSecret?: boolean }>;
    }>;
  };
  _meta?: Record<string, { status?: string; isLatest?: boolean } | undefined>;
}

/** One Registry item, or null when it has nothing Greenhouse can connect to. */
export function toRegistryResult(item: RegistryItem, catalogIds: ReadonlySet<string>): RegistryResult | null {
  const server = item.server;
  if (!server?.name || !server.version) return null;
  const official = item._meta?.['io.modelcontextprotocol.registry/official'];
  if (official?.status && official.status !== 'active') return null;
  // The server-side `version=latest` filter is far slower than filtering here.
  if (official?.isLatest === false) return null;
  const remotes = (server.remotes ?? [])
    .filter((remote) => (remote.type === 'streamable-http' || remote.type === 'sse') && typeof remote.url === 'string')
    // A URL template (`{tenant}`) needs values the Registry does not have.
    .filter((remote) => /^https:\/\//.test(remote.url!) && !/[{}]/.test(remote.url!))
    .map((remote) => ({
      transport: (remote.type === 'sse' ? 'sse' : 'streamable_http') as ConnectorTransport,
      url: remote.url!,
      headers: (remote.headers ?? [])
        .filter((header) => typeof header.name === 'string' && AUTH_HEADER_PATTERN.test(header.name))
        .map((header) => ({
          name: header.name!,
          description: header.description ?? null,
          required: header.isRequired === true,
          secret: header.isSecret === true,
        })),
    }));
  if (!remotes.length) return null;
  return {
    name: server.name,
    title: server.title ?? null,
    description: (server.description ?? '').slice(0, 500),
    version: server.version,
    website_url: server.websiteUrl ?? null,
    remotes,
    catalog_id: catalogIds.has(server.name) ? server.name : null,
  };
}

/** Searches the Registry for remote servers (latest versions only): cached, one request per query at a time. */
export function registrySearch(deps: { baseUrl: string; fetch: FetchLike; catalogIds: () => ReadonlySet<string> }) {
  const cache = new Map<string, { at: number; results: RegistryResult[] }>();
  const pending = new Map<string, Promise<RegistryResult[]>>();

  async function fetchResults(query: string): Promise<RegistryResult[]> {
    const url = new URL('/v0.1/servers', deps.baseUrl);
    url.searchParams.set('limit', '30');
    if (query) url.searchParams.set('search', query);
    let body: { servers?: RegistryItem[] };
    try {
      const response = await deps.fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`the Registry answered HTTP ${response.status}`);
      body = (await response.json()) as { servers?: RegistryItem[] };
    } catch (error) {
      throw new Error(`Could not search the MCP Registry: ${describeError(error)}`);
    }
    const catalogIds = deps.catalogIds();
    const results = (body.servers ?? [])
      .map((item) => toRegistryResult(item, catalogIds))
      .filter((result): result is RegistryResult => result !== null);
    cache.set(query, { at: Date.now(), results });
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    return results;
  }

  return (search: string): Promise<RegistryResult[]> => {
    const query = search.trim().toLowerCase();
    const hit = cache.get(query);
    if (hit && Date.now() - hit.at < REGISTRY_CACHE_MS) return Promise.resolve(hit.results);
    let running = pending.get(query);
    if (!running) {
      running = fetchResults(query).finally(() => pending.delete(query));
      pending.set(query, running);
    }
    return running;
  };
}

// ─── what does an address ask for? ───────────────────────

/**
 * Knock once without credentials and read the answer: a server that lets us in needs no
 * sign-in; one that answers 401 with metadata we can follow is an OAuth server; any other 401
 * wants a key.
 */
export async function probe(url: string, transport: ConnectorTransport, mode: NetworkMode): Promise<ProbeResult> {
  const fetchLike = connectorFetch(url, mode, PROBE_TIMEOUT_MS);
  const result = (fields: Partial<ProbeResult> & Pick<ProbeResult, 'auth'>): ProbeResult => ({
    dynamic_registration: null,
    scopes: [],
    tool_count: null,
    error: null,
    ...fields,
  });
  let response: Response;
  try {
    response = await knock(fetchLike, url);
  } catch (error) {
    return result({ auth: 'unknown', error: describeError(error) });
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
    try {
      const info = await discoverOAuthServerInfo(url, {
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
        fetchFn: fetchLike,
      });
      const metadata = info.authorizationServerMetadata;
      if (metadata?.authorization_endpoint && metadata.token_endpoint) {
        return result({
          auth: 'oauth',
          dynamic_registration: Boolean(metadata.registration_endpoint),
          scopes: scope ? scope.split(' ') : (info.resourceMetadata?.scopes_supported ?? []),
        });
      }
    } catch {
      // No metadata to follow: a key-protected server.
    }
    return result({ auth: 'key' });
  }
  if (!response.ok && response.status !== 405) return result({ auth: 'unknown', error: `HTTP ${response.status}` });
  try {
    const tools = await listTools({ url, transport, headers: {}, fetch: fetchLike });
    return result({ auth: 'none', tool_count: tools.length });
  } catch (error) {
    return result({ auth: 'unknown', error: describeError(error) });
  }
}
