/**
 * The official connector catalog (`connectors/*.json` at the repository root)
 * and the probe that tells an admin what an address asks for.
 *
 * Each catalog file is an official MCP Registry `server.json` whose `_meta`
 * carries Greenhouse's fields under `CONNECTOR_CATALOG_META_KEY`: the
 * suggested slug, how members authenticate, read-only tools the catalog
 * vouches for, and how far the entry was verified. Their auth `mode` (`none` /
 * `key` / `oauth`, each member's own account) maps to `none` /
 * `per_member + key` / `per_member + oauth` here.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { discoverOAuthServerInfo, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  CONNECTOR_AUTH_HEADER_PATTERN,
  CONNECTOR_AUTH_QUERY_PARAM_PATTERN,
  CONNECTOR_CATALOG_META_KEY,
  CONNECTOR_CATEGORIES,
  CONNECTOR_SLUG_PATTERN,
  CONNECTOR_VERIFICATION_LEVELS,
  type ConnectorCatalogEntry,
  type ConnectorProbeResult,
  type ConnectorTransport,
} from '@greenhouse/types/connectors';
import { logger } from '@greenhouse/utils/logger';
import { describeMcpError, discoverMcpTools, knock } from './client.js';
import { connectorFetch, type NetworkPolicy } from './network.js';
import { toErrorMessage } from '@greenhouse/utils/error';

export const REGISTRY_SERVER_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';

/** `connectors/` at the repository root (apps/api/src/connectors → ../../../../). */
export const CATALOG_DIR = fileURLToPath(new URL('../../../../connectors/', import.meta.url));

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), 'must be an https URL');

const remoteSchema = z
  .object({
    type: z.enum(['streamable-http', 'sse']),
    url: httpsUrl,
  })
  .passthrough();

const authSchema = z
  .object({
    mode: z.enum(['none', 'key', 'oauth']),
    header: z.string().regex(CONNECTOR_AUTH_HEADER_PATTERN).optional(),
    query_param: z.string().regex(CONNECTOR_AUTH_QUERY_PARAM_PATTERN).optional(),
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
    (auth) => auth.mode !== 'key' || Boolean(auth.header || auth.query_param),
    'auth: a key entry says where the key goes (header or query_param)',
  )
  .refine(
    (auth) => auth.mode !== 'key' || Boolean(auth.help && auth.help_zh),
    'auth: a key entry needs help + help_zh',
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

function toEntry(file: CatalogFile): ConnectorCatalogEntry {
  const meta = file._meta[CONNECTOR_CATALOG_META_KEY]!;
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
      mode: auth.mode === 'none' ? 'none' : 'per_member',
      kind: auth.mode === 'none' ? null : auth.mode === 'oauth' ? 'oauth' : 'key',
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
export function loadCatalog(dir = CATALOG_DIR): { entries: ConnectorCatalogEntry[]; errors: string[] } {
  const entries: ConnectorCatalogEntry[] = [];
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

let cached: ConnectorCatalogEntry[] | null = null;

/** The catalog, loaded once per process (it ships with the code). */
export function listCatalog(): ConnectorCatalogEntry[] {
  if (!cached) {
    const { entries, errors } = loadCatalog();
    for (const error of errors) logger.warn('[connectors] skipped a catalog file', { error });
    cached = entries;
  }
  return cached;
}

export function findCatalogEntry(id: string): ConnectorCatalogEntry | undefined {
  return listCatalog().find((entry) => entry.id === id);
}

// ─── What does an address ask for? ───────────────────────

/**
 * Knock once without credentials (an `initialize`, as a client's first request
 * would) and read the answer: a server that lets us in needs no sign-in; one
 * that answers 401 with authorization metadata we can follow is an OAuth
 * server; any other 401 wants a key.
 */
export async function probeConnectorAuth(
  url: string,
  transport: ConnectorTransport,
  policy: NetworkPolicy,
): Promise<ConnectorProbeResult> {
  let res: Response;
  try {
    res = await knock({ url, policy });
  } catch (err) {
    return { auth: 'unknown', error: describeMcpError(err) };
  }
  await res.body?.cancel().catch(() => undefined);

  if (res.status === 401 || res.status === 403) {
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(res);
    try {
      const info = await discoverOAuthServerInfo(url, {
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
        fetchFn: connectorFetch(url, policy, 15_000),
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
    const tools = await discoverMcpTools({ url, transport, headers: {}, policy });
    return { auth: 'none', tool_count: tools.length };
  } catch (err) {
    return { auth: 'unknown', error: describeMcpError(err) };
  }
}
