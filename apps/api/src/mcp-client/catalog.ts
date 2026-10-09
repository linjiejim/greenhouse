/**
 * The official connector catalog and the official MCP Registry
 * (spec 20261009-mcp-connectors D11).
 *
 * - **Catalog** — `connectors/*.json` at the repository root. Each file is an
 *   official MCP Registry `server.json` (the Registry's own schema, so an entry
 *   can be lifted from or submitted to it unchanged) whose `_meta` carries
 *   Greenhouse's fields under `CONNECTOR_CATALOG_META_KEY`: the suggested slug,
 *   how members authenticate, read-only tools the catalog vouches for, and how
 *   far the entry was verified against the live server. One PR adding one file
 *   is one contribution; `catalog.test.ts` validates every file.
 * - **Registry** — a read-only search of registry.modelcontextprotocol.io for
 *   remote servers. Unvetted: an admin installs one through the ordinary form,
 *   with no read-only vouching.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { discoverOAuthServerInfo, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  CONNECTOR_CATALOG_META_KEY,
  CONNECTOR_CATEGORIES,
  CONNECTOR_VERIFICATION_LEVELS,
  MCP_AUTH_HEADER_PATTERN,
  MCP_AUTH_QUERY_PARAM_PATTERN,
  MCP_SERVER_SLUG_PATTERN,
  type McpCatalogEntry,
  type McpProbeResult,
  type McpRegistryResult,
  type McpServerTransport,
} from '@greenhouse/types/mcp-servers';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { describeMcpError, discoverMcpTools, guardedMcpFetch, mcpFetch } from './client.js';

/** The official Registry's server.json schema the catalog files declare. */
export const REGISTRY_SERVER_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
export const OFFICIAL_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

/** `connectors/` at the repository root (apps/api/src/mcp-client → ../../../../). */
export const CATALOG_DIR = fileURLToPath(new URL('../../../../connectors/', import.meta.url));

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), 'must be an https URL');

const remoteSchema = z
  .object({
    type: z.enum(['streamable-http', 'sse']),
    url: httpsUrl,
    headers: z
      .array(
        z
          .object({
            name: z.string().regex(MCP_AUTH_HEADER_PATTERN),
            description: z.string().optional(),
            isRequired: z.boolean().optional(),
            isSecret: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const authSchema = z
  .object({
    mode: z.enum(['none', 'per_user', 'oauth']),
    header: z.string().regex(MCP_AUTH_HEADER_PATTERN).optional(),
    query_param: z.string().regex(MCP_AUTH_QUERY_PARAM_PATTERN).optional(),
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
    (auth) => auth.mode !== 'per_user' || Boolean(auth.header || auth.query_param),
    'auth: a per_user entry says where the key goes (header or query_param)',
  )
  .refine(
    (auth) => auth.mode !== 'per_user' || Boolean(auth.help && auth.help_zh),
    'auth: per_user needs help + help_zh',
  );

const metaSchema = z
  .object({
    slug: z.string().regex(MCP_SERVER_SLUG_PATTERN),
    category: z.enum(CONNECTOR_CATEGORIES),
    title_zh: z.string().min(1).max(100).optional(),
    description_zh: z.string().min(1).max(500),
    auth: authSchema,
    read_only_tools: z.array(z.string().min(1)).default([]),
    verification: z
      .object({
        level: z.enum(CONNECTOR_VERIFICATION_LEVELS),
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
    remotes: z.array(remoteSchema).min(1),
    _meta: z.object({ [CONNECTOR_CATALOG_META_KEY]: metaSchema }).passthrough(),
  })
  .passthrough();

export type CatalogFile = z.infer<typeof catalogFileSchema>;

function toEntry(file: CatalogFile): McpCatalogEntry {
  const meta = file._meta[CONNECTOR_CATALOG_META_KEY];
  // Prefer Streamable HTTP; legacy SSE only when that is all the server offers.
  const remote = file.remotes.find((r) => r.type === 'streamable-http') ?? file.remotes[0]!;
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
      zero_config: auth.zero_config,
      ...(auth.header ? { header: auth.header } : {}),
      ...(auth.query_param ? { query_param: auth.query_param } : {}),
      ...(auth.prefix ? { prefix: auth.prefix } : {}),
      ...(auth.help ? { help: auth.help } : {}),
      ...(auth.help_zh ? { help_zh: auth.help_zh } : {}),
      ...(auth.help_url ? { help_url: auth.help_url } : {}),
      ...(auth.scope ? { scope: auth.scope } : {}),
    },
    read_only_tools: meta.read_only_tools,
    verification: meta.verification,
  };
}

/** Parse every catalog file; a broken file is reported, never half-loaded. */
export function loadCatalog(dir = CATALOG_DIR): { entries: McpCatalogEntry[]; errors: string[] } {
  const entries: McpCatalogEntry[] = [];
  const errors: string[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (err) {
    return { entries, errors: [`could not read ${dir}: ${toErrorMessage(err)}`] };
  }
  for (const name of files.sort()) {
    try {
      const parsed = catalogFileSchema.safeParse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        errors.push(`${name}: ${issue?.path.join('.') || '(root)'} — ${issue?.message ?? 'invalid'}`);
        continue;
      }
      entries.push(toEntry(parsed.data));
    } catch (err) {
      errors.push(`${name}: ${toErrorMessage(err)}`);
    }
  }
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) errors.push(`duplicate catalog id "${entry.id}"`);
    if (seenSlugs.has(entry.slug)) errors.push(`duplicate slug "${entry.slug}"`);
    seenIds.add(entry.id);
    seenSlugs.add(entry.slug);
  }
  return { entries, errors };
}

let cached: McpCatalogEntry[] | null = null;

/** The catalog, loaded once per process (it ships with the code). */
export function listCatalog(): McpCatalogEntry[] {
  if (!cached) {
    const { entries, errors } = loadCatalog();
    for (const error of errors) logger.warn('[mcp-catalog] skipped a catalog file', { error });
    cached = entries;
  }
  return cached;
}

export function findCatalogEntry(id: string): McpCatalogEntry | undefined {
  return listCatalog().find((entry) => entry.id === id);
}

// ─── The official MCP Registry ───────────────────────────

/**
 * The Registry promises no latency (its docs tell aggregators to scrape it
 * hourly): measured 2026-10-09 from behind a proxy, a 20-result search took
 * ~28 s and the server-side `version=latest` filter ~80 s — so that filter is
 * applied here instead (`isLatest`).
 */
const REGISTRY_TIMEOUT_MS = 60_000;
const REGISTRY_CACHE_MS = 5 * 60_000;
const registryCache = new Map<string, { at: number; results: McpRegistryResult[] }>();

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

/** Map one Registry item; null when it has nothing Greenhouse can connect to. */
export function toRegistryResult(item: RegistryItem, catalogIds: ReadonlySet<string>): McpRegistryResult | null {
  const server = item.server;
  if (!server?.name || !server.version) return null;
  const official = item._meta?.['io.modelcontextprotocol.registry/official'];
  if (official?.status && official.status !== 'active') return null;
  if (official?.isLatest === false) return null;
  const remotes = (server.remotes ?? [])
    .filter((r) => (r.type === 'streamable-http' || r.type === 'sse') && typeof r.url === 'string')
    // A URL template (`{tenant}`) needs values the Registry does not have.
    .filter((r) => /^https?:\/\//.test(r.url!) && !/[{}]/.test(r.url!))
    .map((r) => ({
      transport: (r.type === 'sse' ? 'sse' : 'streamable_http') as McpServerTransport,
      url: r.url!,
      headers: (r.headers ?? [])
        .filter((h) => typeof h.name === 'string' && MCP_AUTH_HEADER_PATTERN.test(h.name))
        .map((h) => ({
          name: h.name!,
          description: h.description ?? null,
          required: h.isRequired === true,
          secret: h.isSecret === true,
        })),
    }));
  if (remotes.length === 0) return null;
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

/** Search the official Registry for remote servers (latest versions only). */
export async function searchOfficialRegistry(search: string): Promise<McpRegistryResult[]> {
  const key = search.toLowerCase();
  const hit = registryCache.get(key);
  if (hit && Date.now() - hit.at < REGISTRY_CACHE_MS) return hit.results;

  const url = new URL('/v0.1/servers', OFFICIAL_REGISTRY_URL);
  url.searchParams.set('limit', '30');
  if (search) url.searchParams.set('search', search);
  let body: { servers?: RegistryItem[] };
  try {
    const res = await mcpFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the Registry answered HTTP ${res.status}`);
    body = (await res.json()) as { servers?: RegistryItem[] };
  } catch (err) {
    throw new Error(`Could not search the MCP Registry: ${describeMcpError(err)}`);
  }
  const catalogIds = new Set(listCatalog().map((entry) => entry.id));
  const results = (body.servers ?? [])
    .map((item) => toRegistryResult(item, catalogIds))
    .filter((r): r is McpRegistryResult => r !== null);
  registryCache.set(key, { at: Date.now(), results });
  if (registryCache.size > 100) registryCache.delete(registryCache.keys().next().value!);
  return results;
}

// ─── What does an address ask for? ───────────────────────

/**
 * Knock once without credentials (an `initialize`, as a client's first request
 * would) and read the answer: a server that lets us in needs no sign-in; one
 * that answers 401 with protected-resource metadata we can follow is an OAuth
 * server; any other 401 wants a key.
 */
export async function probeServerAuth(url: string, transport: McpServerTransport): Promise<McpProbeResult> {
  const fetchFn = guardedMcpFetch(url);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'greenhouse', version: '0' } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { auth: 'unknown', error: describeMcpError(err) };
  }
  await res.body?.cancel().catch(() => undefined);

  if (res.status === 401 || res.status === 403) {
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(res);
    try {
      const info = await discoverOAuthServerInfo(url, {
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
        fetchFn,
      });
      const metadata = info.authorizationServerMetadata;
      if (metadata?.authorization_endpoint && metadata.token_endpoint) {
        const scopes = scope ? scope.split(' ') : (info.resourceMetadata?.scopes_supported ?? []);
        return {
          auth: 'oauth',
          dynamic_registration: Boolean(metadata.registration_endpoint),
          metadata_document: metadata.client_id_metadata_document_supported === true,
          ...(scopes.length > 0 ? { scopes } : {}),
        };
      }
    } catch {
      // No metadata to follow: a key-protected server.
    }
    return { auth: 'key' };
  }
  if (!res.ok && res.status !== 405) return { auth: 'unknown', error: `the server answered HTTP ${res.status}` };

  try {
    const tools = await discoverMcpTools({ url, transport, headers: {} });
    return { auth: 'none', tool_count: tools.length };
  } catch (err) {
    return { auth: 'unknown', error: describeMcpError(err) };
  }
}
