/**
 * OAuth 2.1 rules with no database and no HTTP: credential formats, PKCE, redirect URIs, scopes
 * and the metadata documents. The service and the routes share them so they cannot drift.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAUTH_SCOPES, type OAuthScope } from '@greenhouse/contract';

export const CODE_TTL_SECONDS = 2 * 60;
export const ACCESS_TTL_SECONDS = 60 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
/** How long a consent page may stay open, from `/oauth/authorize` to the member's decision. */
export const REQUEST_TTL_SECONDS = 10 * 60;

/** Credential prefixes: a log line or a secret scanner can tell what leaked, and a lookup can refuse early. */
export const PREFIX = {
  code: 'gnh_ac_',
  access: 'gnh_at_',
  refresh: 'gnh_rt_',
  personal: 'gnh_pat_',
  secret: 'gnh_cs_',
} as const;

/** A random credential: prefix and 32 random bytes in base64url. */
export function newCredential(kind: keyof typeof PREFIX): string {
  return `${PREFIX[kind]}${randomBytes(32).toString('base64url')}`;
}

/** The longest credential we hand out, with room; anything longer is refused before hashing. */
export const CREDENTIAL_MAX = 128;

/** Errors in the RFC 6749 shape: `{ error, error_description }`. */
export class OAuthError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 429,
    readonly error: string,
    message: string,
  ) {
    super(message);
  }
}

export const invalidRequest = (message: string) => new OAuthError(400, 'invalid_request', message);
export const invalidGrant = (message = 'The grant is invalid, expired or revoked.') =>
  new OAuthError(400, 'invalid_grant', message);
export const invalidClient = (message = 'Client authentication failed.') =>
  new OAuthError(401, 'invalid_client', message);

// --- PKCE (RFC 7636), S256 only ---

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** A S256 challenge is the base64url of 32 bytes. */
export function isPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function isPkceVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

/** Compares in constant time. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!isPkceVerifier(verifier)) return false;
  return sameText(pkceChallenge(verifier), challenge);
}

/** Equal strings, compared in constant time for equal lengths. */
export function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// --- Redirect URIs ---

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'blob:',
  'about:',
  'ws:',
  'wss:',
  'ftp:',
]);

/**
 * A redirect URI a client may register: https; http only on a loopback host (a native app's
 * local listener); or an app's private scheme (`cursor://…`). Never a fragment or credentials.
 * Returns the URI as given, or null.
 */
export function checkRedirectUri(raw: string): string | null {
  if (raw.length > 2048 || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash || raw.includes('#') || url.username || url.password) return null;
  if (url.protocol === 'https:') return url.hostname ? raw : null;
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname) ? raw : null;
  if (FORBIDDEN_SCHEMES.has(url.protocol) || !/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) return null;
  return raw;
}

/**
 * The redirect URI must be one the client registered, character for character. The one
 * exception is a loopback URI, whose port may differ (RFC 8252 §7.3, OAuth 2.1 §8.4.2): a
 * native app listens on whatever port is free.
 */
export function matchRedirectUri(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let asked: URL;
  try {
    asked = new URL(requested);
  } catch {
    return false;
  }
  if (asked.protocol !== 'http:' || !LOOPBACK_HOSTS.has(asked.hostname) || requested.includes('#')) return false;
  return registered.some((entry) => {
    let known: URL;
    try {
      known = new URL(entry);
    } catch {
      return false;
    }
    return (
      known.protocol === 'http:' &&
      known.hostname === asked.hostname &&
      known.pathname === asked.pathname &&
      known.search === asked.search
    );
  });
}

/** The redirect with the response parameters added to its query. */
export function withParams(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, value);
  return url.href;
}

// --- Scopes ---

const KNOWN = new Set<string>(OAUTH_SCOPES);

export function isScope(value: string): value is OAuthScope {
  return KNOWN.has(value);
}

/** Known scopes only, in the canonical order, without repeats. */
export function orderScopes(scopes: Iterable<string>): OAuthScope[] {
  const wanted = new Set(scopes);
  return OAUTH_SCOPES.filter((scope) => wanted.has(scope));
}

/**
 * The scopes a client asks for. Clients rarely know our groups: most echo `scopes_supported`,
 * some add their own (`openid`, `offline_access`), some send nothing. Unknown ones are ignored,
 * and asking for none of ours means asking for all of them; the consent page is where the member
 * decides, and only what they approve is stored.
 */
export function requestedScopes(raw: string | undefined | null): OAuthScope[] {
  const known = orderScopes((raw ?? '').split(/\s+/).filter(Boolean));
  return known.length ? known : [...OAUTH_SCOPES];
}

/**
 * Scopes a token or a client names for itself (`scope` on refresh or client_credentials):
 * every one must be known, so a typo narrows nothing silently. Null when one is not.
 */
export function namedScopes(raw: string): OAuthScope[] | null {
  const names = raw.split(/\s+/).filter(Boolean);
  if (!names.length || names.some((name) => !isScope(name))) return null;
  return orderScopes(names);
}

export function isSubset(scopes: readonly string[], of: readonly string[]): boolean {
  const allowed = new Set(of);
  return scopes.every((scope) => allowed.has(scope));
}

export function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && isSubset(a, b) && isSubset(b, a);
}

/** What a stored set still means today: known scopes only, never widened. */
export function intersectScopes(...sets: ReadonlyArray<readonly string[] | null>): OAuthScope[] {
  let result: string[] = [...OAUTH_SCOPES];
  for (const set of sets) if (set) result = result.filter((scope) => set.includes(scope));
  return orderScopes(result);
}

// --- Where things live ---

export interface Endpoints {
  /** The authorization server's identifier: PUBLIC_URL without a trailing slash. */
  issuer: string;
  /** The one protected resource: tokens are bound to it (RFC 8707). */
  resource: string;
  /** RFC 9728 metadata for the resource, path-specific. */
  resourceMetadata: string;
  /** Where the web app shows the consent page. */
  consentPage: string;
}

export function endpointsFor(publicUrl: string): Endpoints {
  const url = new URL(publicUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const issuer = `${url.origin}${path}`;
  return {
    issuer,
    resource: `${issuer}/api/mcp`,
    // RFC 9728 §3.1: the well-known segment goes between the origin and the resource's path.
    resourceMetadata: `${url.origin}/.well-known/oauth-protected-resource${path}/api/mcp`,
    consentPage: `${issuer}/#/oauth/consent`,
  };
}

/**
 * A `resource` parameter names our resource (RFC 8707): the same URL, a trailing slash allowed.
 * Absent means ours.
 */
export function isOurResource(endpoints: Endpoints, raw: string | undefined): boolean {
  if (raw === undefined) return true;
  try {
    const url = new URL(raw);
    if (url.search || url.hash) return false;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}` === endpoints.resource;
  } catch {
    return false;
  }
}

/** RFC 8414 authorization server metadata. */
export function serverMetadata(endpoints: Endpoints) {
  const { issuer } = endpoints;
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
  };
}

/** RFC 9728 protected resource metadata for `/api/mcp`. */
export function resourceMetadata(endpoints: Endpoints) {
  return {
    resource: endpoints.resource,
    authorization_servers: [endpoints.issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Greenhouse',
  };
}

/** The `WWW-Authenticate` challenge of `/api/mcp` (RFC 6750 §3, RFC 9728 §5.1). */
export function bearerChallenge(endpoints: Endpoints, error?: 'invalid_token' | 'insufficient_scope'): string {
  const params = [`resource_metadata="${endpoints.resourceMetadata}"`, `scope="${OAUTH_SCOPES.join(' ')}"`];
  if (error) params.push(`error="${error}"`);
  return `Bearer ${params.join(', ')}`;
}

/** A client name as people will see it: no control characters, at most 120 characters. */
export function cleanName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const control = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f);
  const name = Array.from(raw, (char) => (control(char.codePointAt(0)!) ? ' ' : char))
    .join('')
    .trim()
    .slice(0, 120);
  return name || fallback;
}
