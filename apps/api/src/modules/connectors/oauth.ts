/**
 * Members' sign-ins to OAuth connectors: the client side of the MCP authorization spec.
 *
 * The SDK's `auth()` does the protocol: protected-resource discovery (RFC 9728), authorization
 * server metadata (RFC 8414 / OIDC), dynamic client registration (RFC 7591), PKCE S256, the
 * `resource` indicator (RFC 8707), the code exchange and refresh. This module gives it a
 * provider backed by the database and decides what the SDK leaves to the application:
 *
 * - One client per connector: every member signs in through the same registration (sealed on
 *   the connector row). It registers again when the callback address moves; a client an admin
 *   entered by hand is never dropped.
 * - The `state` is sealed: it names the member, the connector, the PKCE verifier and the
 *   callback address, and lives ten minutes. Only that member can finish the sign-in.
 * - Refresh without races: calls that may refresh hold a lock per member and connector, and a
 *   refresh only overwrites the tokens it read, so a rotated refresh token is never replaced by
 *   a stale one.
 */

import { randomBytes } from 'node:crypto';
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ConnectionRow, ConnectorRow } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { createKeyedLock } from '../../engine/locks.js';
import { knock } from './mcp.js';
import { connectorFetch, isBrowserSafeUrl, type NetworkMode } from './network.js';
import { placeOf, seal, unseal } from './secrets.js';
import {
  findConnection,
  markConnection,
  replaceTokens,
  saveConnection,
  saveDiscovery,
  saveOAuthClient,
  type TokenSecrets,
} from './store.js';

export const CALLBACK_PATH = '/api/connectors/oauth/callback';
/** How long a started sign-in may take (the member is on the provider's consent page meanwhile). */
export const SIGN_IN_TTL_MS = 10 * 60_000;
/** Each sign-in request's own deadline (discovery, registration, the token endpoint). */
export const SIGN_IN_REQUEST_TIMEOUT_MS = 15_000;
const STATE_PURPOSE = 'connector-sign-in';

/** The sign-in no longer works and only the member can start a new one. */
export class SignInRequired extends Error {
  override name = 'SignInRequired';
  constructor(message = 'The sign-in to this connector is no longer valid: reconnect it.') {
    super(message);
  }
}

/** A sign-in problem the member reads as is. */
export class SignInError extends Error {
  override name = 'SignInError';
}

export interface OAuthDeps {
  key: Buffer;
  mode: NetworkMode;
  /** Where the provider sends the browser back. */
  redirectUri: string;
}

/** The client this workspace uses at one connector's authorization server. */
export interface StoredClient {
  client_id: string;
  client_secret?: string;
  source: 'dynamic' | 'manual';
  /** The callback it was registered for; null for a client an admin entered. */
  redirect_uri: string | null;
  registered_at: string;
}

export function readClient(key: Buffer, connector: Pick<ConnectorRow, 'id' | 'oauthClientEnc'>): StoredClient | null {
  const client = unseal<StoredClient>(key, placeOf.oauthClient(connector.id), connector.oauthClientEnc);
  return client && typeof client.client_id === 'string' && client.client_id ? client : null;
}

export function sealClient(key: Buffer, connectorId: string, client: StoredClient): string {
  return seal(key, placeOf.oauthClient(connectorId), client);
}

/** A client an admin registered at the provider by hand (providers without dynamic registration). */
export function manualClient(key: Buffer, connectorId: string, clientId: string, clientSecret?: string): string {
  return sealClient(key, connectorId, {
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    source: 'manual',
    redirect_uri: null,
    registered_at: new Date().toISOString(),
  });
}

// ─── state ───────────────────────────────────────────────

export interface SignInState {
  /** Member */
  m: string;
  /** Connector */
  c: string;
  /** PKCE verifier */
  v: string;
  /** The redirect URI the authorization request named (the token request repeats it). */
  r: string;
  /** Expiry, epoch ms. */
  e: number;
}

export function sealState(key: Buffer, input: Omit<SignInState, 'e'>, ttlMs = SIGN_IN_TTL_MS): string {
  return Buffer.from(seal(key, placeOf.signInState, { p: STATE_PURPOSE, ...input, e: Date.now() + ttlMs })).toString(
    'base64url',
  );
}

/** The sealed state, or null when it was tampered with, is for something else, or expired. */
export function openState(key: Buffer, raw: string | null | undefined): SignInState | null {
  if (!raw || raw.length > 4096) return null;
  const parsed = unseal<Partial<SignInState> & { p?: string }>(
    key,
    placeOf.signInState,
    Buffer.from(raw, 'base64url').toString('utf8'),
  );
  if (!parsed || parsed.p !== STATE_PURPOSE) return null;
  const { m, c, v, r, e } = parsed;
  if (typeof m !== 'string' || typeof c !== 'string' || typeof v !== 'string' || typeof r !== 'string') return null;
  if (typeof e !== 'number' || e < Date.now()) return null;
  return { m, c, v, r, e };
}

// ─── the provider ────────────────────────────────────────

/**
 * - `authorize`: a member pressed Connect: discover, register if needed, build the address of
 *   the provider's consent page. Stored tokens are ignored: Connect always signs in again.
 * - `callback`: the member came back with a code: exchange it and store the sign-in.
 * - `call`: a tool call or a test: supply the stored tokens and accept a refresh; a needed new
 *   sign-in throws SignInRequired.
 */
type Mode = 'authorize' | 'callback' | 'call';

export class ConnectorOAuthProvider implements OAuthClientProvider {
  /** Set in authorize mode: where the member must go. */
  authorizationUrl: URL | null = null;
  private readonly redirect: string;
  private connector: ConnectorRow;
  private verifier: string | null;
  /** The secrets `tokens()` handed out: the compare-and-set guard for a refresh. */
  private loaded: { row: ConnectionRow; sealed: string } | null = null;
  /** Every token this request saw, so a server that echoes one cannot pass it on. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly deps: OAuthDeps,
    connector: ConnectorRow,
    private readonly memberId: string,
    private readonly mode: Mode,
    options: { verifier?: string; redirectUri?: string } = {},
  ) {
    this.connector = connector;
    this.verifier = options.verifier ?? null;
    this.redirect = options.redirectUri ?? deps.redirectUri;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Greenhouse',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // A public client: PKCE protects the code, and no secret lives anywhere a browser reaches.
      token_endpoint_auth_method: 'none',
      ...(this.connector.oauthScope ? { scope: this.connector.oauthScope } : {}),
    };
  }

  state(): string {
    // Replaced in redirectToAuthorization by the sealed state, which needs the PKCE verifier
    // that only exists after this is called.
    return randomBytes(16).toString('base64url');
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const stored = readClient(this.deps.key, this.connector);
    if (!stored) return undefined;
    // A registration names its callback: when this workspace's address moved, register again.
    if (this.mode === 'authorize' && stored.source === 'dynamic' && stored.redirect_uri !== this.redirect) {
      return undefined;
    }
    return { client_id: stored.client_id, ...(stored.client_secret ? { client_secret: stored.client_secret } : {}) };
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const sealed = sealClient(this.deps.key, this.connector.id, {
      client_id: info.client_id,
      ...(info.client_secret ? { client_secret: info.client_secret } : {}),
      source: 'dynamic',
      redirect_uri: this.redirect,
      registered_at: new Date().toISOString(),
    });
    await saveOAuthClient(this.connector.id, sealed);
    this.connector = { ...this.connector, oauthClientEnc: sealed };
    logger.info('[connectors] registered this workspace as an OAuth client', { connector: this.connector.slug });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.mode !== 'call') return undefined;
    const row = await findConnection(this.memberId, this.connector.id);
    if (!row?.secretsEnc || row.status === 'needs_reauth') return undefined;
    const secrets = unseal<TokenSecrets>(this.deps.key, placeOf.connection(row.id), row.secretsEnc);
    // Unreadable (the key changed): treated as no sign-in, so the call ends in "reconnect".
    if (!secrets?.access_token) return undefined;
    this.loaded = { row, sealed: row.secretsEnc };
    this.remember(secrets);
    const expiresIn = row.expiresAt ? Math.floor((Date.parse(row.expiresAt) - Date.now()) / 1000) : undefined;
    return {
      access_token: secrets.access_token,
      token_type: secrets.token_type || 'Bearer',
      ...(secrets.refresh_token ? { refresh_token: secrets.refresh_token } : {}),
      ...(row.scopes.length ? { scope: row.scopes.join(' ') } : {}),
      ...(expiresIn !== undefined ? { expires_in: Math.max(0, expiresIn) } : {}),
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const secrets: TokenSecrets = {
      access_token: tokens.access_token,
      token_type: tokens.token_type || 'Bearer',
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    };
    this.remember(secrets);
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
    const scopes = tokens.scope ? tokens.scope.split(' ').filter(Boolean) : [];
    if (this.mode === 'callback') {
      await saveConnection(this.deps.key, this.memberId, this.connector.id, secrets, { scopes, expiresAt });
      return;
    }
    if (this.mode !== 'call' || !this.loaded) return;
    const written = await replaceTokens(this.deps.key, this.loaded.row, this.loaded.sealed, secrets, expiresAt);
    if (written) this.loaded = { row: this.loaded.row, sealed: written };
    else logger.info('[connectors] another request refreshed this sign-in first', { connector: this.connector.slug });
  }

  /** The tokens this request used, to take out of anything the server sends back. */
  secrets(): string[] {
    return [...this.seen];
  }

  private remember(secrets: TokenSecrets) {
    this.seen.add(secrets.access_token);
    if (secrets.refresh_token) this.seen.add(secrets.refresh_token);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.mode !== 'authorize') throw new SignInRequired();
    if (!this.verifier) throw new Error('The PKCE verifier is missing before the redirect.');
    // The browser goes there: never anything but a web address.
    if (!isBrowserSafeUrl(authorizationUrl.href, this.deps.mode)) {
      throw new SignInError(`${this.connector.name} named a sign-in page this workspace cannot send you to.`);
    }
    authorizationUrl.searchParams.set(
      'state',
      sealState(this.deps.key, { m: this.memberId, c: this.connector.id, v: this.verifier, r: this.redirect }),
    );
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new SignInError('This sign-in has no PKCE verifier: start again.');
    return this.verifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') return;
    if (scope === 'all' || scope === 'client') {
      // A client an admin entered by hand is theirs to fix, never dropped silently.
      if (readClient(this.deps.key, this.connector)?.source !== 'manual') {
        await saveOAuthClient(this.connector.id, null);
        this.connector = { ...this.connector, oauthClientEnc: null };
      }
    }
    if (scope === 'all' || scope === 'discovery') {
      await saveDiscovery(this.connector.id, null);
      this.connector = { ...this.connector, oauthDiscovery: null };
    }
    if ((scope === 'all' || scope === 'tokens') && this.mode === 'call') await this.expireUsedSignIn();
  }

  /** The sign-in this request used was refused with nothing left to renew it: it needs the member. */
  async expireUsedSignIn(reason = 'The provider no longer accepts this sign-in: reconnect it.'): Promise<void> {
    if (this.mode !== 'call' || !this.loaded) return;
    await markConnection(
      this.loaded.row.id,
      { status: 'needs_reauth', error: reason, clearSecrets: true },
      this.loaded.sealed,
    );
    logger.info('[connectors] a member sign-in ended', { connector: this.connector.slug });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const cached = this.connector.oauthDiscovery as Partial<OAuthDiscoveryState> | null;
    return cached && typeof cached.authorizationServerUrl === 'string' ? (cached as OAuthDiscoveryState) : undefined;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const plain = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    await saveDiscovery(this.connector.id, plain);
    this.connector = { ...this.connector, oauthDiscovery: plain };
  }
}

// ─── flows ───────────────────────────────────────────────

/** The SDK reports metadata it refuses as its schema validator's issue list: say it in words. */
function reason(error: unknown): string {
  const message = toErrorMessage(error);
  return /^\s*\[\s*\{/.test(message) && message.includes('"code"')
    ? 'its sign-in metadata is not valid'
    : message.slice(0, 300);
}

const signInFetch = (deps: OAuthDeps, connector: ConnectorRow) =>
  connectorFetch(connector.url, deps.mode, SIGN_IN_REQUEST_TIMEOUT_MS);

/**
 * What the server says when called without credentials: the resource metadata address and
 * scope from WWW-Authenticate, as a client's first 401 would show. A server that lets anyone in
 * is not an OAuth server, and saying so beats a confusing discovery failure.
 */
async function challenge(
  deps: OAuthDeps,
  connector: ConnectorRow,
): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  let response: Response;
  try {
    response = await knock(signInFetch(deps, connector), connector.url);
  } catch (error) {
    throw new SignInError(`Could not reach ${connector.name}: ${toErrorMessage(error)}`);
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
    return { ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) };
  }
  if (response.ok) {
    throw new SignInError(`${connector.name} answered without asking for a sign-in: an admin should set it to "none".`);
  }
  return {};
}

/** A member pressed Connect: the address of the provider's consent page. */
export async function beginSignIn(deps: OAuthDeps, connector: ConnectorRow, memberId: string): Promise<string> {
  const found = await challenge(deps, connector);
  const provider = new ConnectorOAuthProvider(deps, connector, memberId, 'authorize');
  const scope = connector.oauthScope || found.scope;
  let result: Awaited<ReturnType<typeof auth>>;
  try {
    result = await auth(provider, {
      serverUrl: connector.url,
      ...(scope ? { scope } : {}),
      ...(found.resourceMetadataUrl ? { resourceMetadataUrl: found.resourceMetadataUrl } : {}),
      fetchFn: signInFetch(deps, connector),
    });
  } catch (error) {
    if (error instanceof SignInError) throw error;
    throw new SignInError(`${connector.name} could not start a sign-in: ${reason(error)}`);
  }
  if (result !== 'REDIRECT' || !provider.authorizationUrl)
    throw new SignInError(`${connector.name} did not start a sign-in.`);
  return provider.authorizationUrl.toString();
}

/** The member came back with a code: exchange it, with the verifier from their sealed state, and store the sign-in. */
export async function finishSignIn(
  deps: OAuthDeps,
  connector: ConnectorRow,
  state: SignInState,
  code: string,
): Promise<void> {
  const provider = new ConnectorOAuthProvider(deps, connector, state.m, 'callback', {
    verifier: state.v,
    redirectUri: state.r,
  });
  try {
    const result = await auth(provider, {
      serverUrl: connector.url,
      authorizationCode: code,
      fetchFn: signInFetch(deps, connector),
    });
    if (result !== 'AUTHORIZED') throw new Error('the code was not accepted');
  } catch (error) {
    if (error instanceof SignInError) throw error;
    throw new SignInError(`${connector.name} did not accept the sign-in: ${reason(error)}`);
  }
}

/** Best-effort RFC 7009 revocation when a member disconnects; a failure only logs. */
export async function revokeSignIn(deps: OAuthDeps, connector: ConnectorRow, connection: ConnectionRow): Promise<void> {
  const discovery = connector.oauthDiscovery as Partial<OAuthDiscoveryState> | null;
  const endpoint = (discovery?.authorizationServerMetadata as { revocation_endpoint?: unknown } | undefined)
    ?.revocation_endpoint;
  const client = readClient(deps.key, connector);
  const secrets = unseal<TokenSecrets>(deps.key, placeOf.connection(connection.id), connection.secretsEnc);
  if (typeof endpoint !== 'string' || !client || !secrets?.access_token) return;
  const body = new URLSearchParams({
    token: secrets.refresh_token ?? secrets.access_token,
    token_type_hint: secrets.refresh_token ? 'refresh_token' : 'access_token',
    client_id: client.client_id,
  });
  if (client.client_secret) body.set('client_secret', client.client_secret);
  try {
    const response = await connectorFetch(
      connector.url,
      deps.mode,
      5_000,
    )(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    await response.body?.cancel().catch(() => undefined);
  } catch (error) {
    logger.info('[connectors] revocation failed (the sign-in is gone here anyway)', {
      connector: connector.slug,
      error: toErrorMessage(error),
    });
  }
}

const locks = createKeyedLock();

/**
 * One request at a time per member and connector in this process: two calls that both meet an
 * expired token would both refresh, and the second, spending a refresh token the first just
 * rotated away, would get invalid_grant and end the member's sign-in.
 */
export function withConnectionLock<T>(connectorId: string, memberId: string, work: () => Promise<T>): Promise<T> {
  return locks(`${connectorId}:${memberId}`, work);
}
