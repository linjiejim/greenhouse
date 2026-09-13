/**
 * OAuth 2.1 / MCP authorization primitives.
 *
 * This module is deliberately protocol-only: no Hono and no database access.
 * It centralizes token formats, scope/audience validation, redirect URI policy,
 * metadata, and PKCE so routes and middleware cannot drift.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { safeJsonParse } from '@greenhouse/utils/json';
import { MCP_RESOURCE_GROUP_IDS, type McpResourceGroup } from '@greenhouse/types/mcp';

export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const OAUTH_AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;

/**
 * Action scopes — WHAT a token may do. `mcp:read` is mandatory (it is what
 * grants access at all); `mcp:write` additionally exposes the confirm-gated
 * mutating tools.
 */
export const OAUTH_ACTION_SCOPES = ['mcp:read', 'mcp:write'] as const;

/**
 * Resource scopes — WHICH data a token may touch, one per MCP resource group.
 * Orthogonal to the action scopes: the reachable tools are the tools in the
 * granted groups, intersected with the granted action tier.
 */
export const OAUTH_RESOURCE_SCOPES = MCP_RESOURCE_GROUP_IDS.map((id) => `mcp:${id}` as const);

export const OAUTH_SUPPORTED_SCOPES = [...OAUTH_ACTION_SCOPES, ...OAUTH_RESOURCE_SCOPES] as const;
export type OAuthScope = (typeof OAUTH_SUPPORTED_SCOPES)[number];

const RESOURCE_SCOPE_SET = new Set<string>(OAUTH_RESOURCE_SCOPES);

export function isResourceScope(scope: string): boolean {
  return RESOURCE_SCOPE_SET.has(scope);
}

/** The resource groups a scope set authorizes (order follows the registry). */
export function resourceGroupsFromScopes(scopes: readonly OAuthScope[]): McpResourceGroup[] {
  const granted = new Set<string>(scopes);
  return MCP_RESOURCE_GROUP_IDS.filter((id) => granted.has(`mcp:${id}`));
}

const ACCESS_TOKEN_PREFIX = 'lpoa_at_';
const REFRESH_TOKEN_PREFIX = 'lpoa_rt_';
const AUTHORIZATION_CODE_PREFIX = 'lpoa_ac_';
const CLIENT_ID_PREFIX = 'lpoa_client_';
const CLIENT_SECRET_PREFIX = 'lpoa_cs_';

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OAuth base URL must use http or https');
  }
  if (url.search || url.hash) throw new Error('OAuth base URL cannot contain query or fragment');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href.replace(/\/$/, '');
}

export function getOAuthIssuerUrl(): string {
  return normalizeBaseUrl(
    process.env.API_BASE_URL ?? `http://localhost:${process.env.API_PORT ?? process.env.PORT ?? '3000'}`,
  );
}

export function getOAuthWebUrl(): string {
  return normalizeBaseUrl(process.env.WEB_BASE_URL ?? getOAuthIssuerUrl());
}

export function getMcpResourceUrl(): string {
  return `${getOAuthIssuerUrl()}/api/mcp`;
}

export function getProtectedResourceMetadataUrl(): string {
  return `${getOAuthIssuerUrl()}/.well-known/oauth-protected-resource/api/mcp`;
}

export function oauthProtectedResourceMetadata() {
  return {
    resource: getMcpResourceUrl(),
    authorization_servers: [getOAuthIssuerUrl()],
    scopes_supported: [...OAUTH_SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Greenhouse MCP',
  };
}

export function oauthAuthorizationServerMetadata() {
  const issuer = getOAuthIssuerUrl();
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [...OAUTH_SUPPORTED_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  };
}

export function hashOAuthCredential(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function credential(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function generateAuthorizationCode(): string {
  return credential(AUTHORIZATION_CODE_PREFIX);
}

export function generateAccessToken(): string {
  return credential(ACCESS_TOKEN_PREFIX);
}

export function generateRefreshToken(): string {
  return credential(REFRESH_TOKEN_PREFIX);
}

export function generateOAuthClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomBytes(18).toString('base64url')}`;
}

export function generateClientSecret(): string {
  return credential(CLIENT_SECRET_PREFIX);
}

/** Constant-time comparison of a presented secret against its stored hash. */
export function clientSecretMatches(presented: string, storedHash: string): boolean {
  const presentedHash = Buffer.from(hashOAuthCredential(presented), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presentedHash.length === stored.length && timingSafeEqual(presentedHash, stored);
}

export function isOAuthAccessToken(raw: string): boolean {
  return raw.startsWith(ACCESS_TOKEN_PREFIX) && raw.length > ACCESS_TOKEN_PREFIX.length + 32;
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function isValidPkceChallenge(challenge: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(challenge);
}

export function isValidPkceVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(verifier);
}

/**
 * Native-app redirects may use loopback HTTP or a private custom scheme.
 * Web redirects must use HTTPS. Fragments and embedded credentials are never
 * allowed because authorization responses are query based.
 */
export function normalizeRedirectUri(raw: string): string {
  const url = new URL(raw);
  if (url.hash || url.username || url.password) throw new Error('Redirect URI cannot contain fragment or credentials');
  const loopback =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  const customScheme = !['http:', 'https:', 'javascript:', 'data:', 'file:'].includes(url.protocol);
  if (url.protocol !== 'https:' && !loopback && !customScheme) {
    throw new Error('Redirect URI must use HTTPS, loopback HTTP, or a private-use URI scheme');
  }
  return url.href;
}

export function parseStoredStringArray(value: string): string[] {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Validate a scope set and apply the one implication that always holds:
 * `mcp:write` is meaningless without `mcp:read`. Shared by the request and
 * storage paths so they cannot disagree about what a legal scope set is.
 */
function validateScopeSet(scopes: Iterable<string>): Set<OAuthScope> {
  const set = new Set<OAuthScope>();
  for (const scope of scopes) {
    if (!(OAUTH_SUPPORTED_SCOPES as readonly string[]).includes(scope)) {
      throw new Error(`Unsupported scope: ${scope}`);
    }
    set.add(scope as OAuthScope);
  }
  if (set.has('mcp:write')) set.add('mcp:read');
  return set;
}

/** Canonical ordering, so persisted and compared scope arrays are stable. */
function orderScopes(scopes: ReadonlySet<OAuthScope>): OAuthScope[] {
  return OAUTH_SUPPORTED_SCOPES.filter((scope) => scopes.has(scope));
}

/**
 * Parse persisted OAuth scopes. What is stored is exactly what was granted.
 *
 * ⚠️ Deliberately asymmetric with `normalizeOAuthScopes`: this path NEVER
 * expands a missing resource set into "all groups". Adding that expansion here
 * would be a one-line promotion of every stored grant to every resource group —
 * the highest-risk edit in this module. Grants written before resource scopes
 * existed were backfilled by migration precisely so no such branch is needed.
 */
export function parseStoredOAuthScopes(value: string): OAuthScope[] {
  const parsed = safeJsonParse(value, null);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('Stored OAuth scopes are invalid');
  }
  const stored = new Set(parsed);
  let validated: Set<OAuthScope>;
  try {
    validated = validateScopeSet(parsed);
  } catch {
    throw new Error('Stored OAuth scopes are invalid');
  }
  // The implied `mcp:read` must already be present in storage; a row missing it
  // is malformed, and honouring it would hand out authority nobody wrote down.
  if ([...validated].some((scope) => !stored.has(scope))) throw new Error('Stored OAuth scopes are invalid');
  return orderScopes(validated);
}

/**
 * Normalize a *requested* scope string (authorize, refresh, machine-client
 * creation).
 *
 * Clients do not know how we carve the surface into resource groups — most echo
 * `scopes_supported` or send no scope at all. Reading "said nothing about
 * resources" as "asking for all of them" is what keeps existing clients working;
 * the consent screen is where the user narrows it, and the approve endpoint
 * rejects an empty resource set outright.
 */
export function normalizeOAuthScopes(raw?: string): OAuthScope[] {
  const validated = validateScopeSet((raw?.trim() || 'mcp:read').split(/\s+/).filter(Boolean));
  if (!OAUTH_RESOURCE_SCOPES.some((scope) => validated.has(scope))) {
    for (const scope of OAUTH_RESOURCE_SCOPES) validated.add(scope);
  }
  return orderScopes(validated);
}

/**
 * Normalize the scopes a user actually ticked on the consent screen.
 *
 * ⚠️ Validates but NEVER expands. The request-time "named no resource group →
 * wants all of them" default is right for a client that does not know our
 * groups; applying it to a human's explicit selection inverts it — unticking
 * everything would silently grant everything. Callers must still reject a
 * selection that names no resource group (an authorization reaching nothing).
 */
export function normalizeGrantedScopes(raw: readonly string[]): OAuthScope[] {
  return orderScopes(validateScopeSet(raw));
}

export function scopesToString(scopes: readonly OAuthScope[]): string {
  return scopes.join(' ');
}

export function scopesAreSubset(requested: readonly OAuthScope[], granted: readonly OAuthScope[]): boolean {
  const allowed = new Set(granted);
  return requested.every((scope) => allowed.has(scope));
}

export function expiresAt(secondsFromNow: number, now = Date.now()): string {
  return new Date(now + secondsFromNow * 1000).toISOString();
}
