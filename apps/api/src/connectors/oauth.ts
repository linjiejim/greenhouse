/**
 * OAuth sign-ins to connectors — the client side of the MCP authorization spec.
 *
 * The SDK's `auth()` does the protocol: RFC 9728 protected-resource discovery,
 * RFC 8414 / OIDC authorization-server metadata, client identity (a stored
 * registration or RFC 7591 dynamic registration), PKCE S256, RFC 8707
 * `resource`, code exchange and refresh. This module gives it a provider backed
 * by our database and decides what the SDK leaves to the application:
 *
 * - **Whose sign-in.** A member's own (per_member: tokens in
 *   `provider_connections`, AAD `mcp:<id>:<user>:access|refresh`) or the
 *   team's (shared: one sign-in a super made, sealed as JSON into
 *   `mcp_connectors.shared_secret_enc`, AAD `mcp:<id>:shared`).
 * - **One client per instance.** Every sign-in to a connector goes through the
 *   same registration (sealed on the row, AAD `mcp:<id>:oauth-client`); it is
 *   re-registered when the instance's callback address moves, or when the
 *   provider says the client is gone (`invalid_client`) — a client an admin
 *   entered by hand is never dropped silently.
 * - **Stateless `state`.** The PKCE verifier, the member, the connector, the
 *   redirect URI, whose sign-in it is and which client started it (web / mobile)
 *   are sealed into `state` (AES-GCM, purpose-bound AAD, 10 minutes). The
 *   public callback only redirects back to the app; the logged-in app then
 *   calls `finish`, which refuses a state whose member is not the caller.
 * - **Refresh without races.** Calls that may refresh hold a per
 *   (connector, owner) lock, and a refresh only overwrites the tokens it read:
 *   a rotated refresh token is never replaced by a stale one. `invalid_grant`
 *   marks the sign-in `needs_reauth`.
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
import type { DatabaseProvider, McpConnectorRow, ProviderTokenRow } from '@greenhouse/db';
import type { ConnectorOAuthClientSource } from '@greenhouse/types/connectors';
import { nowIso } from '@greenhouse/utils/date';
import { safeJsonParse } from '@greenhouse/utils/json';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { decryptToken, encryptToken } from '../auth/crypto.js';
import { knock } from './client.js';
import { connectorFetch, policyFor } from './network.js';

export const CONNECTOR_CALLBACK_PATH = '/api/connectors/oauth/callback';
/** Where the public callback sends a sign-in the mobile app started. */
export const CONNECTOR_APP_REDIRECT = 'greenhouse://connectors/oauth-finish';

/** How long a started sign-in stays valid (the person is on the provider's consent page meanwhile). */
export const CONNECTOR_STATE_TTL_MS = 10 * 60_000;
const STATE_AAD = 'mcp-oauth-state';
const STATE_PURPOSE = 'mcp-oauth';
const OAUTH_FETCH_TIMEOUT_MS = 20_000;

/** The sign-in ended (refresh refused) and only a person can start a new one. */
export class ConnectorAuthorizationRequired extends Error {
  constructor(message = 'the sign-in for this connector is no longer valid — reconnect it') {
    super(message);
    this.name = 'ConnectorAuthorizationRequired';
  }
}

/** A problem with a sign-in the person should see in words. */
export class ConnectorSignInError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 502 = 400,
  ) {
    super(message);
    this.name = 'ConnectorSignInError';
  }
}

/** Whose sign-in: a member's own, or the team's shared one. */
export type SignInOwner = { kind: 'member'; userId: string } | { kind: 'shared' };

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

/** What the instance tells an authorization server about itself. */
export function connectorClientMetadata(redirectUri: string, scope?: string | null): OAuthClientMetadata {
  const base = connectorBaseUrl();
  return {
    client_name: 'Greenhouse',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // A public client: PKCE protects the code.
    token_endpoint_auth_method: 'none',
    ...(base && /^https:/.test(base) ? { client_uri: base } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** fetch for every OAuth hop of one connector (its network policy; https or same origin only). */
export function oauthFetch(row: Pick<McpConnectorRow, 'url' | 'scope' | 'private_network'>) {
  return connectorFetch(row.url, policyFor(row), OAUTH_FETCH_TIMEOUT_MS);
}

// ─── The instance's client at one server ─────────────────

export interface StoredClient {
  client_id: string;
  client_secret?: string;
  source: ConnectorOAuthClientSource;
  /** The callback the registration was made for; null for a client entered by hand. */
  redirect_uri: string | null;
  registered_at: string;
}

const clientAad = (connectorId: string) => `mcp:${connectorId}:oauth-client`;

export function readStoredClient(row: Pick<McpConnectorRow, 'id' | 'oauth_client_enc'>): StoredClient | null {
  if (!row.oauth_client_enc) return null;
  try {
    const parsed = JSON.parse(decryptToken(row.oauth_client_enc, clientAad(row.id))) as StoredClient;
    return typeof parsed.client_id === 'string' && parsed.client_id ? parsed : null;
  } catch (err) {
    logger.warn('[connectors] stored OAuth client could not be read', {
      connector: row.id,
      error: toErrorMessage(err),
    });
    return null;
  }
}

export function sealStoredClient(connectorId: string, client: StoredClient): string {
  return encryptToken(JSON.stringify(client), clientAad(connectorId));
}

/** A client an admin registered at the provider by hand (providers without registration). */
export function sealManualClient(connectorId: string, clientId: string, clientSecret?: string): string {
  return sealStoredClient(connectorId, {
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    source: 'manual',
    redirect_uri: null,
    registered_at: nowIso(),
  });
}

// ─── Tokens ──────────────────────────────────────────────

export function connectionAad(connectorId: string, userId: string, field: 'access' | 'refresh' | 'credential'): string {
  return `mcp:${connectorId}:${userId}:${field}`;
}

export const sharedAad = (connectorId: string) => `mcp:${connectorId}:shared`;

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  scope?: string;
  expires_at: string | null;
}

function expiresAt(tokens: OAuthTokens): string | null {
  return tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
}

function toOAuthTokens(stored: StoredTokens): OAuthTokens {
  const expiresIn = stored.expires_at ? Math.floor((Date.parse(stored.expires_at) - Date.now()) / 1000) : undefined;
  return {
    access_token: stored.access_token,
    token_type: stored.token_type || 'Bearer',
    ...(stored.refresh_token ? { refresh_token: stored.refresh_token } : {}),
    ...(stored.scope ? { scope: stored.scope } : {}),
    ...(expiresIn !== undefined ? { expires_in: Math.max(0, expiresIn) } : {}),
  };
}

/** The team's shared sign-in, opened from the connector row; null when there is none or it cannot be read. */
export function openSharedTokens(row: Pick<McpConnectorRow, 'id' | 'shared_secret_enc'>): StoredTokens | null {
  if (!row.shared_secret_enc) return null;
  try {
    const parsed = safeJsonParse(decryptToken(row.shared_secret_enc, sharedAad(row.id)), null) as StoredTokens | null;
    return parsed && typeof parsed.access_token === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function sealShared(connectorId: string, tokens: OAuthTokens): string {
  const stored: StoredTokens = {
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    token_type: tokens.token_type || 'Bearer',
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    expires_at: expiresAt(tokens),
  };
  return encryptToken(JSON.stringify(stored), sharedAad(connectorId));
}

function sealMember(connectorId: string, userId: string, tokens: OAuthTokens) {
  return {
    access_token: encryptToken(tokens.access_token, connectionAad(connectorId, userId, 'access')),
    refresh_token: tokens.refresh_token
      ? encryptToken(tokens.refresh_token, connectionAad(connectorId, userId, 'refresh'))
      : null,
    token_type: tokens.token_type || 'Bearer',
    scope: tokens.scope ?? null,
    expires_at: expiresAt(tokens),
  };
}

export function openMemberTokens(connectorId: string, userId: string, row: ProviderTokenRow): OAuthTokens | undefined {
  if (!row.access_token_enc) return undefined;
  return toOAuthTokens({
    access_token: decryptToken(row.access_token_enc, connectionAad(connectorId, userId, 'access')),
    ...(row.refresh_token_enc
      ? { refresh_token: decryptToken(row.refresh_token_enc, connectionAad(connectorId, userId, 'refresh')) }
      : {}),
    token_type: row.token_type || 'Bearer',
    ...(row.scope ? { scope: row.scope } : {}),
    expires_at: row.expires_at,
  });
}

// ─── state ───────────────────────────────────────────────

export type SignInClient = 'web' | 'mobile';

interface SignInState {
  p: typeof STATE_PURPOSE;
  /** The person who started it (and the only one who may finish it). */
  u: string;
  /** Connector id */
  s: string;
  /** PKCE verifier */
  v: string;
  /** Redirect URI the authorization request named (the token request repeats it) */
  r: string;
  /** 1 = the team's shared sign-in (a super), 0 = the person's own */
  sh: 0 | 1;
  /** Which app started it — where the callback sends the person back */
  c: SignInClient;
  /** Expiry, epoch ms */
  e: number;
}

export type OpenedState = Omit<SignInState, 'p'>;

const toBase64Url = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (value: string) => {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return b64 + '='.repeat((4 - (b64.length % 4)) % 4);
};

export function sealSignInState(input: Omit<SignInState, 'p' | 'e'>, ttlMs = CONNECTOR_STATE_TTL_MS): string {
  const payload: SignInState = { p: STATE_PURPOSE, ...input, e: Date.now() + ttlMs };
  return toBase64Url(encryptToken(JSON.stringify(payload), STATE_AAD));
}

/** The sealed state, or null when it was tampered with, is for something else, or expired. */
export function openSignInState(raw: string | undefined | null): OpenedState | null {
  if (!raw || raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let parsed: Partial<SignInState> | null;
  try {
    parsed = safeJsonParse(decryptToken(fromBase64Url(raw), STATE_AAD), null) as Partial<SignInState> | null;
  } catch {
    return null;
  }
  if (!parsed || parsed.p !== STATE_PURPOSE) return null;
  if (typeof parsed.u !== 'string' || typeof parsed.s !== 'string' || typeof parsed.v !== 'string') return null;
  if (typeof parsed.r !== 'string' || typeof parsed.e !== 'number' || parsed.e < Date.now()) return null;
  if (parsed.sh !== 0 && parsed.sh !== 1) return null;
  if (parsed.c !== 'web' && parsed.c !== 'mobile') return null;
  return { u: parsed.u, s: parsed.s, v: parsed.v, r: parsed.r, sh: parsed.sh, c: parsed.c, e: parsed.e };
}

// ─── The provider ────────────────────────────────────────

/**
 * - `authorize`: someone pressed Connect — discover, register if needed, build
 *   the authorization URL. Stored tokens are ignored: Connect always signs in again.
 * - `callback`: the provider sent the person back with a code — exchange it.
 * - `call`: a tool call — supply the stored tokens and accept a refresh; a
 *   needed re-authorization throws `ConnectorAuthorizationRequired`.
 */
type ProviderMode = 'authorize' | 'callback' | 'call';

export interface ConnectorOAuthProviderOptions {
  db: DatabaseProvider;
  connector: McpConnectorRow;
  owner: SignInOwner;
  mode: ProviderMode;
  redirectUri: string;
  /** authorize mode: the person starting it and the app they started it from. */
  actorUserId?: string;
  client?: SignInClient;
  /** callback mode: the PKCE verifier from the sealed state. */
  verifier?: string;
  /** call mode: every token and client secret this provider handles lands here, for redaction. */
  secrets?: string[];
}

export class ConnectorOAuthProvider implements OAuthClientProvider {
  /** Set by `redirectToAuthorization` in authorize mode: where the person must go. */
  authorizationUrl: URL | null = null;
  private verifier: string | null;
  private connector: McpConnectorRow;
  /** The access-token ciphertext `tokens()` handed out — the compare-and-set guard for a refresh. */
  private loaded: string | null = null;
  /** Set once the provider refused this sign-in: the SDK's retry must not try it again. */
  private refused = false;

  constructor(private readonly opts: ConnectorOAuthProviderOptions) {
    this.connector = opts.connector;
    this.verifier = opts.verifier ?? null;
  }

  get redirectUrl(): string {
    return this.opts.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return connectorClientMetadata(this.opts.redirectUri, this.connector.oauth_scope);
  }

  state(): string {
    // A placeholder: `redirectToAuthorization` replaces it with the sealed state,
    // because the PKCE verifier it must carry only exists after this is called.
    return randomBytes(16).toString('base64url');
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = readStoredClient(this.connector);
    // A call never registers a client: that only happens when a person signs in.
    if (!stored && this.opts.mode === 'call') throw new ConnectorAuthorizationRequired();
    if (!stored) return undefined;
    // A registration names its callback: when the instance's address moved, register again.
    if (
      this.opts.mode === 'authorize' &&
      stored.source === 'dynamic' &&
      stored.redirect_uri !== this.opts.redirectUri
    ) {
      return undefined;
    }
    if (stored.client_secret) this.remember(stored.client_secret);
    return { client_id: stored.client_id, ...(stored.client_secret ? { client_secret: stored.client_secret } : {}) };
  }

  private remember(...values: (string | undefined)[]): void {
    for (const value of values) if (value && !this.opts.secrets?.includes(value)) this.opts.secrets?.push(value);
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const sealed = sealStoredClient(this.connector.id, {
      client_id: info.client_id,
      ...(info.client_secret ? { client_secret: info.client_secret } : {}),
      source: 'dynamic',
      redirect_uri: this.opts.redirectUri,
      registered_at: nowIso(),
    });
    // Two first sign-ins at once: the first registration wins; the other person starts again.
    const wrote = await this.opts.db.mcpConnectors.setOAuthClient(
      this.connector.id,
      sealed,
      this.connector.oauth_client_enc,
    );
    if (!wrote)
      throw new ConnectorSignInError('Someone else is setting up this connector right now — press Connect again.');
    this.connector = { ...this.connector, oauth_client_enc: sealed };
    logger.info('[connectors] registered the instance as an OAuth client', { connector: this.connector.id });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.opts.mode !== 'call' || this.refused) return undefined;
    const { owner } = this.opts;
    try {
      if (owner.kind === 'shared') {
        const row = await this.opts.db.mcpConnectors.getById(this.connector.id);
        const stored = row ? openSharedTokens(row) : null;
        if (!row?.shared_secret_enc || !stored) return undefined;
        this.loaded = row.shared_secret_enc;
        return this.remembered(toOAuthTokens(stored));
      }
      const row = await this.opts.db.mcpConnectors.getConnection(owner.userId, this.connector.id);
      if (!row?.access_token_enc) return undefined;
      this.loaded = row.access_token_enc;
      return this.remembered(openMemberTokens(this.connector.id, owner.userId, row));
    } catch {
      // Unreadable (instance key changed, or bound elsewhere): treated as no
      // sign-in, so the call ends in "reconnect" instead of a decryption error.
      return undefined;
    }
  }

  private remembered<T extends OAuthTokens | undefined>(tokens: T): T {
    if (tokens) this.remember(tokens.access_token, tokens.refresh_token);
    return tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const { owner, db } = this.opts;
    this.remembered(tokens);
    const client = readStoredClient(this.connector);
    // A sign-in that started before an address or auth change must not land after it.
    const guard = { url: this.connector.url, auth_mode: this.connector.auth_mode, auth_kind: this.connector.auth_kind };
    const changed = new ConnectorSignInError('The connector changed while you were signing in — connect again.');
    if (owner.kind === 'shared') {
      const sealed = sealShared(this.connector.id, tokens);
      if (this.opts.mode === 'callback') {
        if (!(await db.mcpConnectors.setSharedSecret(this.connector.id, sealed, undefined, guard))) throw changed;
        await db.mcpConnectors.update(this.connector.id, { last_error: null });
        return;
      }
      const wrote = await db.mcpConnectors.setSharedSecret(this.connector.id, sealed, this.loaded);
      if (wrote) this.loaded = sealed;
      return;
    }
    const sealed = sealMember(this.connector.id, owner.userId, tokens);
    if (this.opts.mode === 'callback') {
      const saved = await db.mcpConnectors.saveConnection(
        owner.userId,
        this.connector.id,
        { ...sealed, metadata: { connected_via: 'oauth', ...(client ? { client_id: client.client_id } : {}) } },
        guard,
      );
      if (!saved) throw changed;
      return;
    }
    // A refresh. Write only over the tokens this request read: if another
    // request refreshed first, its rotated refresh token wins.
    const wrote = await db.mcpConnectors.updateConnectionTokens(owner.userId, this.connector.id, this.loaded, sealed);
    if (wrote) this.loaded = sealed.access_token;
    else logger.info('[connectors] another request refreshed this sign-in first', { connector: this.connector.id });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.opts.mode !== 'authorize') throw new ConnectorAuthorizationRequired();
    if (!this.verifier) throw new Error('PKCE verifier missing before the redirect');
    authorizationUrl.searchParams.set(
      'state',
      sealSignInState({
        u: this.opts.actorUserId ?? (this.opts.owner.kind === 'member' ? this.opts.owner.userId : ''),
        s: this.connector.id,
        v: this.verifier,
        r: this.opts.redirectUri,
        sh: this.opts.owner.kind === 'shared' ? 1 : 0,
        c: this.opts.client ?? 'web',
      }),
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
      if (readStoredClient(this.connector)?.source !== 'manual') {
        await db.mcpConnectors.setOAuthClient(this.connector.id, null);
        this.connector = { ...this.connector, oauth_client_enc: null };
      }
    }
    if (scope === 'all' || scope === 'discovery') {
      await db.mcpConnectors.setOAuthDiscovery(this.connector.id, null);
      this.connector = { ...this.connector, oauth_discovery: null };
    }
    if ((scope === 'all' || scope === 'tokens') && this.opts.mode === 'call') await this.expireUsedSignIn();
  }

  /**
   * Expire the sign-in this request used (refused, with nothing left to refresh
   * it with) — unless a newer one was written meanwhile, which stays.
   */
  async expireUsedSignIn(reason = 'The provider no longer accepts this sign-in.'): Promise<void> {
    if (this.opts.mode !== 'call' || !this.loaded) return;
    this.refused = true;
    const { owner, db } = this.opts;
    if (owner.kind === 'shared') {
      if (await db.mcpConnectors.setSharedSecret(this.connector.id, null, this.loaded)) {
        await db.mcpConnectors.update(this.connector.id, { last_error: `Team sign-in expired: ${reason}` });
      }
    } else {
      await db.mcpConnectors.expireConnection(owner.userId, this.connector.id, this.loaded, reason);
    }
    logger.info('[connectors] a sign-in expired', { connector: this.connector.id, owner: owner.kind });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const cached = this.connector.oauth_discovery as Partial<OAuthDiscoveryState> | null;
    return cached && typeof cached.authorizationServerUrl === 'string' ? (cached as OAuthDiscoveryState) : undefined;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const plain = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    await this.opts.db.mcpConnectors.setOAuthDiscovery(this.connector.id, plain);
    this.connector = { ...this.connector, oauth_discovery: plain };
  }
}

// ─── Flows ───────────────────────────────────────────────

/**
 * What the server says when called without credentials: the protected-resource
 * metadata URL and scope from `WWW-Authenticate`. A server that answers
 * without asking for credentials is not an OAuth server.
 */
async function probeChallenge(row: McpConnectorRow): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  let res: Response;
  try {
    res = await knock({ url: row.url, policy: policyFor(row) });
  } catch (err) {
    throw new ConnectorSignInError(`Could not reach ${row.name}: ${toErrorMessage(err)}`, 502);
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 401 || res.status === 403) {
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(res);
    return { ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) };
  }
  if (res.ok) {
    throw new ConnectorSignInError(
      `${row.name} answered without asking for a sign-in — set its sign-in to "none" instead.`,
    );
  }
  return {};
}

/** Someone pressed Connect: return the provider's authorization URL. */
export async function beginConnectorSignIn(
  db: DatabaseProvider,
  row: McpConnectorRow,
  input: { owner: SignInOwner; actorUserId: string; redirectUri: string; client: SignInClient },
): Promise<string> {
  const challenge = await probeChallenge(row);
  const provider = new ConnectorOAuthProvider({
    db,
    connector: row,
    owner: input.owner,
    actorUserId: input.actorUserId,
    client: input.client,
    mode: 'authorize',
    redirectUri: input.redirectUri,
  });
  const scope = row.oauth_scope || challenge.scope;
  let result: Awaited<ReturnType<typeof auth>>;
  try {
    result = await auth(provider, {
      serverUrl: row.url,
      ...(scope ? { scope } : {}),
      ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
      fetchFn: oauthFetch(row),
    });
  } catch (err) {
    if (err instanceof ConnectorSignInError) throw err;
    throw new ConnectorSignInError(`${row.name} could not start a sign-in: ${toErrorMessage(err)}`, 502);
  }
  if (result !== 'REDIRECT' || !provider.authorizationUrl) {
    throw new ConnectorSignInError(`${row.name} did not start a sign-in.`, 502);
  }
  const href = provider.authorizationUrl.toString();
  if (!/^https?:\/\//i.test(href))
    throw new ConnectorSignInError(`${row.name} gave a sign-in address that is not a web page.`, 502);
  return href;
}

/**
 * The provider sent the person back and the logged-in app asks to finish.
 * The caller must be the person who started it (and a super for the team's
 * shared sign-in).
 */
export async function finishConnectorSignIn(
  db: DatabaseProvider,
  input: { state: string | undefined; code: string | undefined; caller: { id: string; role: string } },
): Promise<{ connector: McpConnectorRow; owner: SignInOwner }> {
  const state = openSignInState(input.state);
  if (!state) throw new ConnectorSignInError('This sign-in link is invalid or expired — start again from Greenhouse.');
  if (state.u !== input.caller.id) {
    throw new ConnectorSignInError('This sign-in was started by someone else — start your own from Greenhouse.', 403);
  }
  if (state.sh === 1 && input.caller.role !== 'super') {
    throw new ConnectorSignInError('Only an administrator can connect the team account.', 403);
  }
  if (!input.code || input.code.length > 4096) {
    throw new ConnectorSignInError('The provider did not return an authorization code.');
  }

  const row = await db.mcpConnectors.getById(state.s);
  if (!row || !row.enabled || row.auth_kind !== 'oauth') {
    throw new ConnectorSignInError('This connector is no longer available.', 404);
  }
  if (state.sh === 1 ? row.auth_mode !== 'shared' : row.auth_mode !== 'per_member') {
    throw new ConnectorSignInError('This connector no longer signs in this way — start again.', 404);
  }
  if (row.scope === 'personal' && row.owner_user_id !== input.caller.id) {
    throw new ConnectorSignInError('This connector is no longer available.', 404);
  }
  const owner: SignInOwner = state.sh === 1 ? { kind: 'shared' } : { kind: 'member', userId: state.u };
  const provider = new ConnectorOAuthProvider({
    db,
    connector: row,
    owner,
    mode: 'callback',
    redirectUri: state.r,
    verifier: state.v,
  });
  try {
    const result = await auth(provider, {
      serverUrl: row.url,
      authorizationCode: input.code,
      fetchFn: oauthFetch(row),
    });
    if (result !== 'AUTHORIZED') throw new Error('the code was not accepted');
  } catch (err) {
    if (err instanceof ConnectorSignInError) throw err;
    throw new ConnectorSignInError(`${row.name} did not accept the sign-in: ${toErrorMessage(err)}`, 502);
  }
  return { connector: (await db.mcpConnectors.getById(row.id)) ?? row, owner };
}

/** Best-effort RFC 7009 revocation of one sign-in; failure only logs. */
export async function revokeSignIn(row: McpConnectorRow, tokens: OAuthTokens | undefined): Promise<boolean> {
  const discovery = row.oauth_discovery as Partial<OAuthDiscoveryState> | null;
  const endpoint = (discovery?.authorizationServerMetadata as { revocation_endpoint?: unknown } | undefined)
    ?.revocation_endpoint;
  const client = readStoredClient(row);
  if (typeof endpoint !== 'string' || !client || !tokens) return false;
  const token = tokens.refresh_token ?? tokens.access_token;
  if (!token) return false;
  const body = new URLSearchParams({
    token,
    token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token',
    client_id: client.client_id,
  });
  if (client.client_secret) body.set('client_secret', client.client_secret);
  try {
    const res = await oauthFetch(row)(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch (err) {
    logger.info('[connectors] revocation failed (the local sign-in is gone anyway)', {
      connector: row.id,
      error: toErrorMessage(err),
    });
    return false;
  }
}

/** Revoke a member's stored sign-in (before its row is deleted). */
export async function revokeMemberSignIn(row: McpConnectorRow, userId: string, conn: ProviderTokenRow) {
  let tokens: OAuthTokens | undefined;
  try {
    tokens = openMemberTokens(row.id, userId, conn);
  } catch {
    return false;
  }
  return revokeSignIn(row, tokens);
}

/** Revoke the team's shared sign-in (before it is cleared). */
export async function revokeSharedSignIn(row: McpConnectorRow) {
  const stored = openSharedTokens(row);
  return stored ? revokeSignIn(row, toOAuthTokens(stored)) : false;
}

// ─── One refresh at a time per connector and owner ────────

const locks = new Map<string, Promise<void>>();

/**
 * Serialize work on one sign-in within this process: two parallel calls that
 * both hit an expired token would otherwise both refresh, and the second —
 * using the refresh token the first just rotated away — gets `invalid_grant`.
 */
export async function withSignInLock<T>(connectorId: string, owner: SignInOwner, run: () => Promise<T>): Promise<T> {
  const key = `${connectorId}:${owner.kind === 'shared' ? '*' : owner.userId}`;
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  locks.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}
