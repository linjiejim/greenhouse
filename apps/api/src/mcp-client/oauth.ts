/**
 * Members' OAuth sign-ins to connectors — the client side of the MCP
 * authorization spec (spec 20261009-mcp-connectors D3–D5).
 *
 * The SDK's `auth()` does the protocol: RFC 9728 protected-resource discovery,
 * RFC 8414 / OIDC authorization-server metadata, client identity (a client-id
 * metadata document, a stored registration, or RFC 7591 dynamic registration),
 * PKCE S256, RFC 8707 `resource`, code exchange and refresh. This module gives
 * it a provider backed by our database and decides three things the SDK leaves
 * to the application:
 *
 * - **One client per instance.** Every member signs in through the same
 *   registration (stored encrypted on the connector row); it is re-registered
 *   only when the instance's callback address moves.
 * - **Stateless `state`.** The PKCE verifier, the member and the connector are
 *   sealed into `state` itself (AES-GCM, purpose-bound), so the public callback
 *   needs no server-side session and works on any instance (D4). The callback
 *   stores tokens for the member named in the state — never "whoever's browser
 *   this is" — so a link someone else started can only connect THEIR account.
 * - **Refresh without races.** Calls that may refresh hold a per-(member,
 *   connector) lock, and a refresh only overwrites the tokens it read: a rotated
 *   refresh token is never replaced by a stale one (D5).
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
import type { DatabaseProvider, McpServerRow, ProviderTokenRow } from '@greenhouse/db';
import type { McpOAuthClientSource } from '@greenhouse/types/mcp-servers';
import { nowIso } from '@greenhouse/utils/date';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { decryptToken, encryptToken } from '../auth/crypto.js';
import { guardedMcpFetch } from './client.js';

export const CONNECTOR_CALLBACK_PATH = '/api/connectors/oauth/callback';
export const CONNECTOR_CLIENT_METADATA_PATH = '/api/connectors/oauth/client-metadata.json';

/** How long a started sign-in stays valid (the member is on the provider's consent page meanwhile). */
export const CONNECTOR_STATE_TTL_MS = 10 * 60_000;
const STATE_AAD = 'mcp-oauth-state';
const STATE_PURPOSE = 'mcp-oauth';

/** The sign-in ended (refresh refused) and only the member can start a new one. */
export class ConnectorAuthorizationRequired extends Error {
  constructor(message = 'the sign-in for this connector is no longer valid — reconnect it') {
    super(message);
    this.name = 'ConnectorAuthorizationRequired';
  }
}

/** A problem with a sign-in the member should see in words (shown on the callback page). */
export class ConnectorSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorSignInError';
  }
}

// ─── Addresses ───────────────────────────────────────────

/** The instance's public base URL: PUBLIC_BASE_URL, else the request's own origin (same rule as Feishu/WeCom). */
export function connectorBaseUrl(requestUrl?: string): string | null {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return requestUrl ? new URL(requestUrl).origin : null;
}

export function connectorRedirectUri(requestUrl?: string): string | null {
  const base = connectorBaseUrl(requestUrl);
  return base ? `${base}${CONNECTOR_CALLBACK_PATH}` : null;
}

/**
 * The client-id metadata document URL (SEP-991). Only an https PUBLIC_BASE_URL
 * qualifies: an authorization server has to fetch it, and the SDK refuses
 * anything else. Without one, the instance registers dynamically instead.
 */
export function connectorClientMetadataUrl(): string | undefined {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (!configured) return undefined;
  try {
    const base = new URL(configured);
    if (base.protocol !== 'https:') return undefined;
    return `${configured.replace(/\/+$/, '')}${CONNECTOR_CLIENT_METADATA_PATH}`;
  } catch {
    return undefined;
  }
}

/** What the instance tells an authorization server about itself (registration and metadata document alike). */
export function connectorClientMetadata(redirectUri: string, scope?: string | null): OAuthClientMetadata {
  const base = connectorBaseUrl();
  return {
    client_name: 'Greenhouse',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // A public client: PKCE protects the code, and no secret has to live
    // anywhere a member's browser could reach.
    token_endpoint_auth_method: 'none',
    ...(base && /^https:/.test(base) ? { client_uri: base } : {}),
    ...(scope ? { scope } : {}),
  };
}

// ─── The instance's client at one server ─────────────────

interface StoredClient {
  client_id: string;
  client_secret?: string;
  source: McpOAuthClientSource;
  /** The callback the registration was made for; null for a client the admin registered by hand. */
  redirect_uri: string | null;
  registered_at: string;
}

function clientAad(serverId: number): string {
  return `mcp:${serverId}:oauth-client`;
}

export function readStoredClient(server: Pick<McpServerRow, 'id' | 'oauth_client_encrypted'>): StoredClient | null {
  if (!server.oauth_client_encrypted) return null;
  try {
    const parsed = JSON.parse(decryptToken(server.oauth_client_encrypted, clientAad(server.id))) as StoredClient;
    return typeof parsed.client_id === 'string' && parsed.client_id ? parsed : null;
  } catch (err) {
    logger.warn('[mcp-oauth] stored OAuth client could not be read', {
      serverId: server.id,
      error: toErrorMessage(err),
    });
    return null;
  }
}

export function sealStoredClient(serverId: number, client: StoredClient): string {
  return encryptToken(JSON.stringify(client), clientAad(serverId));
}

/** A client the admin registered at the provider by hand (GitHub and other servers without registration). */
export function manualClient(serverId: number, clientId: string, clientSecret?: string): string {
  return sealStoredClient(serverId, {
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    source: 'manual',
    redirect_uri: null,
    registered_at: nowIso(),
  });
}

// ─── Members' tokens ─────────────────────────────────────

export function connectionAad(serverId: number, userId: string, field: 'access' | 'refresh' | 'credential'): string {
  return `mcp:${serverId}:${userId}:${field}`;
}

function sealTokens(serverId: number, userId: string, tokens: OAuthTokens) {
  return {
    access_token: encryptToken(tokens.access_token, connectionAad(serverId, userId, 'access')),
    refresh_token: tokens.refresh_token
      ? encryptToken(tokens.refresh_token, connectionAad(serverId, userId, 'refresh'))
      : undefined,
    token_type: tokens.token_type || 'Bearer',
    scope: tokens.scope ?? null,
    expires_at: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
  };
}

export function openTokens(serverId: number, userId: string, row: ProviderTokenRow): OAuthTokens | undefined {
  if (!row.access_token) return undefined;
  const expiresIn = row.expires_at ? Math.floor((Date.parse(row.expires_at) - Date.now()) / 1000) : undefined;
  return {
    access_token: decryptToken(row.access_token, connectionAad(serverId, userId, 'access')),
    token_type: row.token_type || 'Bearer',
    ...(row.refresh_token
      ? { refresh_token: decryptToken(row.refresh_token, connectionAad(serverId, userId, 'refresh')) }
      : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    ...(expiresIn !== undefined ? { expires_in: Math.max(0, expiresIn) } : {}),
  };
}

// ─── state ───────────────────────────────────────────────

interface SignInState {
  p: typeof STATE_PURPOSE;
  /** Member */
  u: string;
  /** Connector (server id) */
  s: number;
  /** PKCE verifier */
  v: string;
  /** Redirect URI the authorization request named (the token request must repeat it) */
  r: string;
  /** Expiry, epoch ms */
  e: number;
}

function toBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return base64 + '='.repeat((4 - (base64.length % 4)) % 4);
}

export function sealSignInState(input: Omit<SignInState, 'p' | 'e'>, ttlMs = CONNECTOR_STATE_TTL_MS): string {
  const payload: SignInState = { p: STATE_PURPOSE, ...input, e: Date.now() + ttlMs };
  return toBase64Url(encryptToken(JSON.stringify(payload), STATE_AAD));
}

/** The sealed state, or null when it was tampered with, is for something else, or expired. */
export function openSignInState(raw: string | undefined | null): Omit<SignInState, 'p'> | null {
  if (!raw || raw.length > 2048) return null;
  let parsed: Partial<SignInState> | null;
  try {
    parsed = safeJsonParse(decryptToken(fromBase64Url(raw), STATE_AAD), null) as Partial<SignInState> | null;
  } catch {
    return null;
  }
  if (!parsed || parsed.p !== STATE_PURPOSE) return null;
  if (typeof parsed.u !== 'string' || typeof parsed.s !== 'number' || typeof parsed.v !== 'string') return null;
  if (typeof parsed.r !== 'string' || typeof parsed.e !== 'number' || parsed.e < Date.now()) return null;
  return { u: parsed.u, s: parsed.s, v: parsed.v, r: parsed.r, e: parsed.e };
}

// ─── The provider ────────────────────────────────────────

/**
 * - `authorize`: a member pressed Connect — discover, register if needed, build
 *   the authorization URL. Existing tokens are ignored: Connect always signs in again.
 * - `callback`: the provider sent the member back with a code — exchange it.
 * - `call`: a tool call — supply the stored tokens and accept a refresh; a
 *   needed re-authorization throws `ConnectorAuthorizationRequired`.
 */
type ProviderMode = 'authorize' | 'callback' | 'call';

export interface ConnectorOAuthProviderOptions {
  db: DatabaseProvider;
  server: McpServerRow;
  userId: string;
  mode: ProviderMode;
  redirectUri: string;
  /** The PKCE verifier from the sealed state (callback mode). */
  verifier?: string;
}

export class ConnectorOAuthProvider implements OAuthClientProvider {
  /** Set by `redirectToAuthorization` in authorize mode: where the member must go. */
  authorizationUrl: URL | null = null;
  private verifier: string | null;
  private server: McpServerRow;
  /** The access-token ciphertext `tokens()` handed out — the compare-and-set guard for a refresh. */
  private loadedAccessToken: string | null = null;

  constructor(private readonly opts: ConnectorOAuthProviderOptions) {
    this.server = opts.server;
    this.verifier = opts.verifier ?? null;
  }

  get redirectUrl(): string {
    return this.opts.redirectUri;
  }

  get clientMetadataUrl(): string | undefined {
    // Only a fresh sign-in may pick its client identity; a call reuses the stored one.
    return this.opts.mode === 'authorize' ? connectorClientMetadataUrl() : undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return connectorClientMetadata(this.opts.redirectUri, this.server.oauth_scope);
  }

  state(): string {
    // A placeholder: `redirectToAuthorization` replaces it with the sealed state,
    // because the PKCE verifier it must carry only exists after this is called.
    return randomBytes(16).toString('base64url');
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = readStoredClient(this.server);
    if (!stored) return undefined;
    if (this.opts.mode === 'authorize' && stored.source !== 'manual') {
      // A registration names its callback: when the instance's address moved, register again.
      if (stored.source === 'dynamic' && stored.redirect_uri !== this.opts.redirectUri) return undefined;
      if (stored.source === 'metadata_document' && stored.client_id !== connectorClientMetadataUrl()) return undefined;
    }
    return { client_id: stored.client_id, ...(stored.client_secret ? { client_secret: stored.client_secret } : {}) };
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const source: McpOAuthClientSource =
      info.client_id === connectorClientMetadataUrl() ? 'metadata_document' : 'dynamic';
    const sealed = sealStoredClient(this.server.id, {
      client_id: info.client_id,
      ...(info.client_secret ? { client_secret: info.client_secret } : {}),
      source,
      redirect_uri: this.opts.redirectUri,
      registered_at: nowIso(),
    });
    await this.opts.db.mcpServers.setOAuthClient(this.server.id, sealed);
    this.server = { ...this.server, oauth_client_encrypted: sealed };
    logger.info('[mcp-oauth] registered the instance as an OAuth client', { server: this.server.slug, source });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.opts.mode !== 'call') return undefined;
    const row = await this.opts.db.mcpServers.getConnection(this.opts.userId, this.server.id);
    if (!row?.access_token) return undefined;
    this.loadedAccessToken = row.access_token;
    try {
      return openTokens(this.server.id, this.opts.userId, row);
    } catch {
      // Unreadable (instance key changed): treated as no sign-in, so the call
      // ends in "reconnect" instead of an opaque decryption error.
      return undefined;
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const sealed = sealTokens(this.server.id, this.opts.userId, tokens);
    if (this.opts.mode === 'callback') {
      const client = readStoredClient(this.server);
      await this.opts.db.mcpServers.saveConnection(this.opts.userId, this.server.id, {
        ...sealed,
        refresh_token: sealed.refresh_token ?? null,
        metadata: { connected_via: 'oauth', ...(client ? { client_id: client.client_id } : {}) },
      });
      return;
    }
    // A refresh. Write only over the tokens this request read: if another
    // request refreshed first, its rotated refresh token wins.
    const wrote = await this.opts.db.mcpServers.updateConnectionTokens(
      this.opts.userId,
      this.server.id,
      this.loadedAccessToken,
      sealed,
    );
    if (wrote) this.loadedAccessToken = sealed.access_token;
    else logger.info('[mcp-oauth] another request refreshed this sign-in first', { server: this.server.slug });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.opts.mode !== 'authorize') throw new ConnectorAuthorizationRequired();
    if (!this.verifier) throw new Error('PKCE verifier missing before the redirect');
    authorizationUrl.searchParams.set(
      'state',
      sealSignInState({ u: this.opts.userId, s: this.server.id, v: this.verifier, r: this.opts.redirectUri }),
    );
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new ConnectorSignInError('This sign-in has no PKCE verifier — start again.');
    return this.verifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') return;
    const { db } = this.opts;
    if (scope === 'all' || scope === 'client') {
      // A client the admin entered by hand is theirs to fix — never silently dropped.
      if (readStoredClient(this.server)?.source !== 'manual') {
        await db.mcpServers.setOAuthClient(this.server.id, null);
        this.server = { ...this.server, oauth_client_encrypted: null };
      }
    }
    if (scope === 'all' || scope === 'discovery') {
      await db.mcpServers.setOAuthDiscovery(this.server.id, null);
      this.server = { ...this.server, oauth_discovery: null };
    }
    if ((scope === 'all' || scope === 'tokens') && this.opts.mode === 'call') await this.expireUsedSignIn();
  }

  /**
   * Expire the sign-in this request used (refused, with nothing left to refresh
   * it with) — unless a newer one was written meanwhile, which stays.
   */
  async expireUsedSignIn(reason = 'The provider no longer accepts this sign-in.'): Promise<void> {
    if (this.opts.mode !== 'call' || !this.loadedAccessToken) return;
    const row = await this.opts.db.mcpServers.getConnection(this.opts.userId, this.server.id);
    if (row?.access_token && row.access_token === this.loadedAccessToken) {
      await this.opts.db.mcpServers.expireConnection(this.opts.userId, this.server.id, reason);
      logger.info('[mcp-oauth] a member sign-in expired', { server: this.server.slug });
    }
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const cached = this.server.oauth_discovery as Partial<OAuthDiscoveryState> | null;
    return cached && typeof cached.authorizationServerUrl === 'string' ? (cached as OAuthDiscoveryState) : undefined;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const plain = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    await this.opts.db.mcpServers.setOAuthDiscovery(this.server.id, plain);
    this.server = { ...this.server, oauth_discovery: plain };
  }
}

// ─── Flows ───────────────────────────────────────────────

/**
 * What the server says when called without credentials: the protected-resource
 * metadata URL and scope from `WWW-Authenticate` (what a real client sees on
 * its first 401). A server that answers without asking for credentials is not
 * an OAuth server, and saying so beats a confusing discovery failure.
 */
async function probeChallenge(server: McpServerRow): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  const fetchFn = guardedMcpFetch(server.url);
  let res: Response;
  try {
    res = await fetchFn(server.url, {
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
    throw new ConnectorSignInError(`Could not reach ${server.name}: ${toErrorMessage(err)}`);
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 401 || res.status === 403) {
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(res);
    return { ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) };
  }
  if (res.ok) {
    throw new ConnectorSignInError(
      `${server.name} answered without asking for a sign-in — an administrator should set its sign-in to "none".`,
    );
  }
  return {};
}

/** A member pressed Connect: return the provider's authorization URL. */
export async function beginConnectorSignIn(
  db: DatabaseProvider,
  server: McpServerRow,
  userId: string,
  redirectUri: string,
): Promise<string> {
  const challenge = await probeChallenge(server);
  const provider = new ConnectorOAuthProvider({ db, server, userId, mode: 'authorize', redirectUri });
  const scope = server.oauth_scope || challenge.scope;
  let result: Awaited<ReturnType<typeof auth>>;
  try {
    result = await auth(provider, {
      serverUrl: server.url,
      ...(scope ? { scope } : {}),
      ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
      fetchFn: guardedMcpFetch(server.url),
    });
  } catch (err) {
    if (err instanceof ConnectorSignInError) throw err;
    throw new ConnectorSignInError(`${server.name} could not start a sign-in: ${toErrorMessage(err)}`);
  }
  if (result !== 'REDIRECT' || !provider.authorizationUrl) {
    throw new ConnectorSignInError(`${server.name} did not start a sign-in.`);
  }
  return provider.authorizationUrl.toString();
}

/** The provider sent the member back: exchange the code and store the sign-in. */
export async function finishConnectorSignIn(
  db: DatabaseProvider,
  input: { state: string | undefined; code: string | undefined },
): Promise<{ server: McpServerRow; userId: string }> {
  const state = openSignInState(input.state);
  if (!state) throw new ConnectorSignInError('This sign-in link is invalid or expired — start again from Greenhouse.');
  if (!input.code) throw new ConnectorSignInError('The provider did not return an authorization code.');

  const server = await db.mcpServers.getById(state.s);
  if (!server || !server.enabled || server.auth_mode !== 'oauth') {
    throw new ConnectorSignInError('This connector is no longer available.');
  }
  const user = await db.users.getById(state.u);
  if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) {
    throw new ConnectorSignInError('This account can no longer connect.');
  }

  const provider = new ConnectorOAuthProvider({
    db,
    server,
    userId: state.u,
    mode: 'callback',
    redirectUri: state.r,
    verifier: state.v,
  });
  try {
    const result = await auth(provider, {
      serverUrl: server.url,
      authorizationCode: input.code,
      fetchFn: guardedMcpFetch(server.url),
    });
    if (result !== 'AUTHORIZED') throw new Error('the code was not accepted');
  } catch (err) {
    if (err instanceof ConnectorSignInError) throw err;
    throw new ConnectorSignInError(`${server.name} did not accept the sign-in: ${toErrorMessage(err)}`);
  }
  return { server: (await db.mcpServers.getById(server.id)) ?? server, userId: state.u };
}

/** Best-effort RFC 7009 revocation when a member disconnects; failure only logs. */
export async function revokeConnectorSignIn(
  server: McpServerRow,
  userId: string,
  row: ProviderTokenRow,
): Promise<void> {
  const discovery = server.oauth_discovery as Partial<OAuthDiscoveryState> | null;
  // RFC 8414 metadata names it; the OIDC discovery shape the SDK also accepts does not type it.
  const endpoint = (discovery?.authorizationServerMetadata as { revocation_endpoint?: unknown } | undefined)
    ?.revocation_endpoint;
  const client = readStoredClient(server);
  if (typeof endpoint !== 'string' || !client) return;
  let token: string | undefined;
  let hint: 'refresh_token' | 'access_token' = 'refresh_token';
  try {
    const opened = openTokens(server.id, userId, row);
    token = opened?.refresh_token ?? opened?.access_token;
    if (!opened?.refresh_token) hint = 'access_token';
  } catch {
    return;
  }
  if (!token) return;
  const body = new URLSearchParams({ token, token_type_hint: hint, client_id: client.client_id });
  if (client.client_secret) body.set('client_secret', client.client_secret);
  try {
    await guardedMcpFetch(server.url)(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    logger.info('[mcp-oauth] revocation failed (the local sign-in is gone anyway)', {
      server: server.slug,
      error: toErrorMessage(err),
    });
  }
}

// ─── One refresh at a time per member and connector ──────

const connectionLocks = new Map<string, Promise<void>>();

/**
 * Serialize work on one member's sign-in to one connector within this process:
 * two parallel tool calls that both hit an expired token would otherwise both
 * refresh, and the second refresh — using the refresh token the first one just
 * rotated away — gets `invalid_grant` and signs the member out (D5).
 */
export async function withConnectionLock<T>(serverId: number, userId: string, run: () => Promise<T>): Promise<T> {
  const key = `${serverId}:${userId}`;
  const previous = connectionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  connectionLocks.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (connectionLocks.get(key) === tail) connectionLocks.delete(key);
  }
}
