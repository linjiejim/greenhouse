/**
 * External access: the OAuth 2.1 authorization server in front of `/api/mcp`, personal access
 * tokens, the clients a member authorized and the clients an admin manages.
 *
 * - Codes, access, refresh and personal tokens and client secrets exist in plain text only in the
 *   response that hands them out; rows keep keyed hashes.
 * - Every token carries the member's auth_version: a password change or disabling ends it.
 * - A grant keeps exactly the scopes the member approved; a token never reaches beyond its grant,
 *   its client's allowance and the scopes that exist.
 * - A refresh token is single use. Presenting a used one again, or a used code, revokes every
 *   token of that grant.
 * - A machine client acts as its member only after that member approves it (unless the admin
 *   bound it to themself): an admin cannot read a member's conversations through a client.
 */

import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  type AdminClient,
  type ConsentDecisionInput,
  type ConsentRequest,
  type CreateClientInput,
  type CreatedClient,
  type CreatedPersonalToken,
  type Grant,
  type OAuthScope,
  type Page,
  type PersonalToken,
  type RotatedSecret,
  type UpdateClientInput,
  type createPersonalTokenInputSchema,
} from '@greenhouse/contract';
import {
  getDb,
  idempotencyKeys,
  members,
  newId,
  oauthClients,
  oauthCodes,
  oauthGrants,
  oauthTokens,
  PERSONAL_CLIENT_ID,
  transaction,
  type Db,
  type OAuthClient,
  type OAuthGrant,
  type OAuthGrantStatus,
  type OAuthToken,
} from '@greenhouse/db';
import type { z } from 'zod';
import { audit, changedFields } from '../../audit.js';
import type { Tokens } from '../../auth/tokens.js';
import { ApiError, conflict, invalidInput, notFound } from '../../http/errors.js';
import { decodeCursor, encodeCursor, toPage } from '../../http/pagination.js';
import {
  ACCESS_TTL_SECONDS,
  CODE_TTL_SECONDS,
  CREDENTIAL_MAX,
  OAuthError,
  PREFIX,
  REFRESH_TTL_SECONDS,
  REQUEST_TTL_SECONDS,
  checkRedirectUri,
  cleanName,
  endpointsFor,
  intersectScopes,
  invalidClient,
  invalidGrant,
  invalidRequest,
  isOurResource,
  isPkceChallenge,
  isSubset,
  matchRedirectUri,
  namedScopes,
  newCredential,
  orderScopes,
  pkceMatches,
  requestedScopes,
  sameScopes,
  sameText,
  withParams,
} from './protocol.js';

type CreatePersonalToken = z.output<typeof createPersonalTokenInputSchema>;

/** A consent request lives in idempotency_keys under this scope, keyed by the hash of its handle. */
const REQUESTS = 'oauth_request';
const MAX_PERSONAL_TOKENS = 20;
const TOUCH_AFTER_MS = 60_000;

/** What `/oauth/authorize` was asked, once checked, kept until the member decides. */
interface PendingRequest {
  client_id: string;
  redirect_uri: string;
  scopes: OAuthScope[];
  state: string | null;
  code_challenge: string;
  /** The first member who opened the consent page; nobody else can use the handle after that. */
  member_id: string | null;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

/** Who is calling `/api/mcp`: the member a token acts for, through which client, with what. */
export interface Caller {
  memberId: string;
  clientId: string;
  clientName: string;
  grantId: string;
  scopes: OAuthScope[];
}

/** Client credentials at the token and revocation endpoints: the body, or HTTP Basic. */
export interface ClientAuth {
  basic: { id: string; secret: string } | null;
  form: Record<string, string>;
}

const kindOf = (client: OAuthClient) => (client.authMethod === 'client_secret_post' ? 'machine' : 'interactive');
const registrationOf = (client: OAuthClient) => (client.registration === 'admin' ? 'admin' : 'dynamic');
const expired = (at: string) => Date.parse(at) <= Date.now();
const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

/** A token that still works: not revoked or traded in, not expired, from the member's current sign-in. */
const liveToken = and(
  isNull(oauthTokens.revokedAt),
  isNull(oauthTokens.rotatedAt),
  gt(oauthTokens.expiresAt, sql`now()`),
  eq(oauthTokens.authVersion, members.authVersion),
  eq(members.status, 'active'),
  eq(oauthGrants.status, 'active'),
);

const requestInvalid = () =>
  new ApiError(400, 'oauth_request_invalid', 'This sign-in request has expired or was used. Start again in the app.');

export function createOAuthService(deps: { tokens: Tokens; publicUrl: string }) {
  const endpoints = endpointsFor(deps.publicUrl);
  const hash = (secret: string, purpose: 'oauth_code' | 'oauth_token' | 'oauth_secret' | 'oauth_request') =>
    deps.tokens.hashSecret(secret, purpose);

  /** An interactive client that can still finish an authorization at this redirect URI. */
  async function usableClient(db: Db, clientId: string, redirectUri: string): Promise<OAuthClient | null> {
    const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId));
    if (!client || client.status !== 'active' || client.registration === 'builtin') return null;
    if (client.authMethod !== 'none' || !matchRedirectUri(client.redirectUris, redirectUri)) return null;
    return client;
  }

  /** Ends what a grant handed out: live tokens and unused codes. */
  async function endCredentials(db: Db, grantIds: string[]): Promise<void> {
    if (!grantIds.length) return;
    await db
      .update(oauthTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(inArray(oauthTokens.grantId, grantIds), isNull(oauthTokens.revokedAt)));
    await db
      .update(oauthCodes)
      .set({ usedAt: sql`now()` })
      .where(and(inArray(oauthCodes.grantId, grantIds), isNull(oauthCodes.usedAt)));
  }

  /** Old rows of a grant: expired a day ago, traded in a week ago, revoked a month ago. */
  async function prune(db: Db, grantId: string): Promise<void> {
    await db
      .delete(oauthTokens)
      .where(
        and(
          eq(oauthTokens.grantId, grantId),
          or(
            lt(oauthTokens.expiresAt, sql`now() - interval '1 day'`),
            lt(oauthTokens.rotatedAt, sql`now() - interval '7 days'`),
            lt(oauthTokens.revokedAt, sql`now() - interval '30 days'`),
          ),
        ),
      );
    await db
      .delete(oauthCodes)
      .where(and(eq(oauthCodes.grantId, grantId), lt(oauthCodes.expiresAt, sql`now() - interval '1 day'`)));
  }

  /**
   * Creates or updates the member's grant to a client. A grant whose scopes change, or that comes
   * back after being revoked, starts over: its earlier tokens and unused codes end.
   */
  async function saveGrant(
    db: Db,
    memberId: string,
    clientId: string,
    scopes: string[],
    status: OAuthGrantStatus,
  ): Promise<OAuthGrant> {
    const where = and(
      eq(oauthGrants.memberId, memberId),
      eq(oauthGrants.clientId, clientId),
      eq(oauthGrants.resource, endpoints.resource),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const [existing] = await db.select().from(oauthGrants).where(where).for('update');
      if (existing) {
        const changed = existing.status !== status || !sameScopes(existing.scopes, scopes);
        const [updated] = await db
          .update(oauthGrants)
          .set({ scopes, status, revokedAt: null, updatedAt: sql`now()` })
          .where(eq(oauthGrants.id, existing.id))
          .returning();
        if (changed) await endCredentials(db, [existing.id]);
        return updated!;
      }
      const [created] = await db
        .insert(oauthGrants)
        .values({ id: newId('oauthGrant'), memberId, clientId, resource: endpoints.resource, scopes, status })
        .onConflictDoNothing()
        .returning();
      if (created) return created;
    }
    throw new Error('Could not save the grant.');
  }

  async function issuePair(
    db: Db,
    grant: OAuthGrant,
    scopes: OAuthScope[],
    refreshScopes: OAuthScope[],
    authVersion: number,
  ): Promise<TokenResponse> {
    const access = newCredential('access');
    const refresh = newCredential('refresh');
    const base = { grantId: grant.id, resource: grant.resource, authVersion };
    await db.insert(oauthTokens).values([
      {
        ...base,
        id: newId('oauthToken'),
        kind: 'access',
        tokenHash: hash(access, 'oauth_token'),
        scopes,
        expiresAt: inSeconds(ACCESS_TTL_SECONDS),
      },
      {
        ...base,
        id: newId('oauthToken'),
        kind: 'refresh',
        tokenHash: hash(refresh, 'oauth_token'),
        scopes: refreshScopes,
        expiresAt: inSeconds(REFRESH_TTL_SECONDS),
      },
    ]);
    await prune(db, grant.id);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  /** Reuse of a spent code or refresh token: everything of that grant ends, and it is recorded. */
  async function reuseDetected(db: Db, grant: OAuthGrant, what: 'code' | 'refresh_token'): Promise<void> {
    await endCredentials(db, [grant.id]);
    await audit({
      actorType: 'client',
      actorId: grant.clientId,
      clientId: grant.clientId,
      onBehalfOf: grant.memberId,
      action: 'oauth_grant.reuse',
      resourceType: 'oauth_grant',
      resourceId: grant.id,
      result: 'denied',
      summary: what,
    });
  }

  /** The client behind a token or revocation request: known, enabled, its secret right when it has one. */
  async function authenticateClient(auth: ClientAuth): Promise<OAuthClient> {
    const formId = auth.form.client_id;
    if (auth.basic && formId && formId !== auth.basic.id) throw invalidRequest('Two different client ids were sent.');
    const clientId = auth.basic?.id ?? formId;
    if (!clientId || clientId.length > 64) throw invalidClient('client_id is required.');
    const secret = auth.basic?.secret ?? auth.form.client_secret;
    const [client] = await getDb().select().from(oauthClients).where(eq(oauthClients.id, clientId));
    if (!client || client.registration === 'builtin' || client.status !== 'active') {
      throw invalidClient('This client is unknown or disabled.');
    }
    if (client.authMethod === 'client_secret_post') {
      const ok =
        !!secret &&
        secret.length <= CREDENTIAL_MAX &&
        !!client.secretHash &&
        sameText(hash(secret, 'oauth_secret'), client.secretHash);
      if (!ok) throw invalidClient('The client secret is wrong.');
    }
    return client;
  }

  async function exchangeCode(client: OAuthClient, form: Record<string, string>): Promise<TokenResponse> {
    const { code, code_verifier: verifier, redirect_uri: redirectUri } = form;
    if (!code || !verifier || !redirectUri) throw invalidRequest('code, code_verifier and redirect_uri are required.');
    if (!isOurResource(endpoints, form.resource)) throw new OAuthError(400, 'invalid_target', 'Unknown resource.');
    if (code.length > CREDENTIAL_MAX || !code.startsWith(PREFIX.code)) throw invalidGrant();
    const result = await transaction(async (db): Promise<TokenResponse | 'invalid' | 'replayed'> => {
      const [row] = await db
        .select({ code: oauthCodes, grant: oauthGrants, member: members })
        .from(oauthCodes)
        .innerJoin(oauthGrants, eq(oauthGrants.id, oauthCodes.grantId))
        .innerJoin(members, eq(members.id, oauthGrants.memberId))
        .where(eq(oauthCodes.codeHash, hash(code, 'oauth_code')))
        .for('update', { of: oauthCodes });
      // Someone else's code, or a guess at the verifier: refused without spending it.
      if (!row || row.grant.clientId !== client.id || row.code.redirectUri !== redirectUri) return 'invalid';
      if (!pkceMatches(verifier, row.code.codeChallenge)) return 'invalid';
      if (row.code.usedAt) {
        await reuseDetected(db, row.grant, 'code');
        return 'replayed';
      }
      if (expired(row.code.expiresAt)) return 'invalid';
      await db
        .update(oauthCodes)
        .set({ usedAt: sql`now()` })
        .where(eq(oauthCodes.codeHash, row.code.codeHash));
      const scopes = intersectScopes(row.code.scopes, row.grant.scopes, client.allowedScopes);
      if (
        row.grant.status !== 'active' ||
        row.member.status !== 'active' ||
        row.member.authVersion !== row.code.authVersion ||
        !scopes.length ||
        !isSubset(row.code.scopes, row.grant.scopes)
      ) {
        return 'invalid';
      }
      return issuePair(db, row.grant, scopes, scopes, row.member.authVersion);
    });
    if (result === 'replayed') throw invalidGrant('This code was already used; the tokens it gave were revoked.');
    if (result === 'invalid') throw invalidGrant('The code is invalid, expired or already used.');
    return result;
  }

  async function refresh(client: OAuthClient, form: Record<string, string>): Promise<TokenResponse> {
    const raw = form.refresh_token;
    if (!raw) throw invalidRequest('refresh_token is required.');
    if (!isOurResource(endpoints, form.resource)) throw new OAuthError(400, 'invalid_target', 'Unknown resource.');
    const narrowed = form.scope ? namedScopes(form.scope) : null;
    if (form.scope && !narrowed) throw new OAuthError(400, 'invalid_scope', 'Unknown scope.');
    if (raw.length > CREDENTIAL_MAX || !raw.startsWith(PREFIX.refresh)) throw invalidGrant();
    const result = await transaction(async (db): Promise<TokenResponse | 'invalid' | 'replayed' | 'scope'> => {
      const [row] = await db
        .select({ token: oauthTokens, grant: oauthGrants, member: members })
        .from(oauthTokens)
        .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
        .innerJoin(members, eq(members.id, oauthGrants.memberId))
        .where(and(eq(oauthTokens.tokenHash, hash(raw, 'oauth_token')), eq(oauthTokens.kind, 'refresh')))
        .for('update', { of: oauthTokens });
      if (!row || row.grant.clientId !== client.id) return 'invalid';
      if (row.token.rotatedAt) {
        await reuseDetected(db, row.grant, 'refresh_token');
        return 'replayed';
      }
      if (
        row.token.revokedAt ||
        expired(row.token.expiresAt) ||
        row.grant.status !== 'active' ||
        row.member.status !== 'active' ||
        row.member.authVersion !== row.token.authVersion
      ) {
        return 'invalid';
      }
      const base = intersectScopes(row.token.scopes, row.grant.scopes, client.allowedScopes);
      if (narrowed && !isSubset(narrowed, base)) return 'scope';
      const scopes = narrowed ?? base;
      if (!scopes.length) return 'invalid';
      await db
        .update(oauthTokens)
        .set({ rotatedAt: sql`now()`, lastUsedAt: sql`now()` })
        .where(eq(oauthTokens.id, row.token.id));
      return issuePair(db, row.grant, scopes, base, row.member.authVersion);
    });
    if (result === 'replayed') {
      throw invalidGrant('This refresh token was already used; every token of this authorization was revoked.');
    }
    if (result === 'scope') throw new OAuthError(400, 'invalid_scope', 'A refresh cannot add scopes.');
    if (result === 'invalid') throw invalidGrant('The refresh token is invalid, expired or revoked.');
    return result;
  }

  async function clientCredentials(client: OAuthClient, form: Record<string, string>): Promise<TokenResponse> {
    if (!isOurResource(endpoints, form.resource)) throw new OAuthError(400, 'invalid_target', 'Unknown resource.');
    const narrowed = form.scope ? namedScopes(form.scope) : null;
    if (form.scope && !narrowed) throw new OAuthError(400, 'invalid_scope', 'Unknown scope.');
    if (!client.boundMemberId) throw invalidGrant('This client acts for nobody.');
    return transaction(async (db) => {
      const [row] = await db
        .select({ grant: oauthGrants, member: members })
        .from(oauthGrants)
        .innerJoin(members, eq(members.id, oauthGrants.memberId))
        .where(
          and(
            eq(oauthGrants.clientId, client.id),
            eq(oauthGrants.memberId, client.boundMemberId!),
            eq(oauthGrants.resource, endpoints.resource),
          ),
        );
      if (!row) throw invalidGrant('This client acts for nobody.');
      if (row.grant.status === 'pending') throw invalidGrant('Its member has not approved this client yet.');
      if (row.grant.status !== 'active') throw invalidGrant('Its member revoked this client.');
      if (row.member.status !== 'active') throw invalidGrant('Its member is not active.');
      const base = intersectScopes(row.grant.scopes, client.allowedScopes);
      if (narrowed && !isSubset(narrowed, base))
        throw new OAuthError(400, 'invalid_scope', 'More than it was granted.');
      const scopes = narrowed ?? base;
      if (!scopes.length) throw invalidGrant('Nothing is granted to this client.');
      const access = newCredential('access');
      await db.insert(oauthTokens).values({
        id: newId('oauthToken'),
        grantId: row.grant.id,
        kind: 'access',
        tokenHash: hash(access, 'oauth_token'),
        resource: row.grant.resource,
        scopes,
        authVersion: row.member.authVersion,
        expiresAt: inSeconds(ACCESS_TTL_SECONDS),
      });
      await prune(db, row.grant.id);
      return {
        access_token: access,
        token_type: 'Bearer' as const,
        expires_in: ACCESS_TTL_SECONDS,
        scope: scopes.join(' '),
      };
    });
  }

  // --- Views ---

  /** Live tokens and the last use per grant. */
  async function grantActivity(grantIds: string[]) {
    if (!grantIds.length) return new Map<string, { tokens: number; lastUsedAt: string | null }>();
    const rows = await getDb()
      .select({
        grantId: oauthTokens.grantId,
        tokens: sql<number>`(count(*) filter (where ${liveToken}))::int`,
        lastUsedAt: sql<string | null>`max(${oauthTokens.lastUsedAt})`,
      })
      .from(oauthTokens)
      .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
      .innerJoin(members, eq(members.id, oauthGrants.memberId))
      .where(inArray(oauthTokens.grantId, grantIds))
      .groupBy(oauthTokens.grantId);
    return new Map(rows.map((row) => [row.grantId, { tokens: row.tokens, lastUsedAt: row.lastUsedAt }]));
  }

  function toGrant(grant: OAuthGrant, client: OAuthClient, activity?: { tokens: number; lastUsedAt: string | null }) {
    return {
      id: grant.id,
      client: {
        id: client.id,
        name: client.name,
        kind: kindOf(client),
        registration: registrationOf(client),
        status: client.status,
      },
      scopes: grant.scopes,
      status: grant.status === 'pending' ? 'pending' : 'active',
      active_tokens: activity?.tokens ?? 0,
      last_used_at: activity?.lastUsedAt ?? null,
      created_at: grant.createdAt,
      updated_at: grant.updatedAt,
    } satisfies Grant;
  }

  async function adminViews(rows: OAuthClient[]): Promise<AdminClient[]> {
    if (!rows.length) return [];
    const db = getDb();
    const ids = rows.map((row) => row.id);
    const machines = rows.filter((row) => row.boundMemberId);
    const [activity, bound] = await Promise.all([
      db
        .select({
          clientId: oauthGrants.clientId,
          grants: sql<number>`(count(distinct ${oauthGrants.id}) filter (where ${oauthGrants.status} = 'active'))::int`,
          tokens: sql<number>`(count(${oauthTokens.id}) filter (where ${liveToken}))::int`,
          lastUsedAt: sql<string | null>`max(${oauthTokens.lastUsedAt})`,
        })
        .from(oauthGrants)
        .innerJoin(members, eq(members.id, oauthGrants.memberId))
        .leftJoin(oauthTokens, eq(oauthTokens.grantId, oauthGrants.id))
        .where(inArray(oauthGrants.clientId, ids))
        .groupBy(oauthGrants.clientId),
      machines.length
        ? db
            .select({ clientId: oauthClients.id, member: members, status: oauthGrants.status })
            .from(oauthClients)
            .innerJoin(members, eq(members.id, oauthClients.boundMemberId))
            .leftJoin(
              oauthGrants,
              and(eq(oauthGrants.clientId, oauthClients.id), eq(oauthGrants.memberId, oauthClients.boundMemberId)),
            )
            .where(
              inArray(
                oauthClients.id,
                machines.map((row) => row.id),
              ),
            )
        : [],
    ]);
    const stats = new Map(activity.map((row) => [row.clientId, row]));
    const boundTo = new Map(bound.map((row) => [row.clientId, row]));
    return rows.map((client) => {
      const counts = stats.get(client.id);
      const machine = boundTo.get(client.id);
      return {
        id: client.id,
        name: client.name,
        kind: kindOf(client),
        registration: registrationOf(client),
        status: client.status,
        redirect_uris: client.redirectUris,
        allowed_scopes: client.allowedScopes,
        bound_member: machine
          ? { id: machine.member.id, name: machine.member.name, email: machine.member.email }
          : null,
        bound_grant_status: machine?.status ?? null,
        active_grants: counts?.grants ?? 0,
        active_tokens: counts?.tokens ?? 0,
        last_used_at: counts?.lastUsedAt ?? null,
        created_at: client.createdAt,
        updated_at: client.updatedAt,
      } satisfies AdminClient;
    });
  }

  async function adminView(id: string): Promise<AdminClient> {
    const [row] = await getDb()
      .select()
      .from(oauthClients)
      .where(and(eq(oauthClients.id, id), ne(oauthClients.registration, 'builtin')));
    if (!row) throw notFound('Client');
    return (await adminViews([row]))[0]!;
  }

  function toPersonal(token: OAuthToken): PersonalToken {
    return {
      id: token.id,
      name: token.name ?? '',
      scopes: token.scopes,
      status: expired(token.expiresAt) ? 'expired' : 'active',
      last_used_at: token.lastUsedAt,
      expires_at: token.expiresAt,
      created_at: token.createdAt,
    };
  }

  /** Redirect URIs an admin or a client registers: each one allowed, no repeats. */
  function redirectUris(raw: unknown): string[] | null {
    if (!Array.isArray(raw) || !raw.length || raw.length > 10) return null;
    const checked = raw.map((entry) => (typeof entry === 'string' ? checkRedirectUri(entry) : null));
    if (checked.some((entry) => entry === null)) return null;
    return [...new Set(checked as string[])];
  }

  const service = {
    endpoints,

    // --- The protocol ---

    /**
     * RFC 7591 registration of an interactive (public) client. It can only use the authorization
     * code flow with PKCE; anything else it asks for is replaced (RFC 7591 §3.2.1). Clients that
     * registered more than 30 days ago and were never authorized are cleared away here.
     */
    async register(body: Record<string, unknown>) {
      const uris = redirectUris(body.redirect_uris);
      if (!uris) {
        throw new OAuthError(
          400,
          'invalid_redirect_uri',
          'redirect_uris must list 1 to 10 URIs: https, http on a loopback host, or an app scheme; no fragments.',
        );
      }
      const name = cleanName(body.client_name, 'MCP client');
      const db = getDb();
      await db
        .delete(oauthClients)
        .where(
          and(
            eq(oauthClients.registration, 'dynamic'),
            lt(oauthClients.createdAt, sql`now() - interval '30 days'`),
            sql`not exists (select 1 from ${oauthGrants} where ${oauthGrants.clientId} = ${oauthClients.id})`,
          ),
        );
      const [client] = await db
        .insert(oauthClients)
        .values({ id: newId('oauthClient'), name, redirectUris: uris, authMethod: 'none', registration: 'dynamic' })
        .returning();
      return {
        client_id: client!.id,
        client_id_issued_at: Math.floor(Date.parse(client!.createdAt) / 1000),
        client_name: client!.name,
        redirect_uris: client!.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      };
    },

    /**
     * `/oauth/authorize`: checks the request and parks it behind a single-use handle the consent
     * page opens. Returns where to send the browser: the consent page with `request=`; or, for a
     * bad request, the client with an error when an admin registered it, else the consent page
     * with `error=`.
     */
    async authorize(query: Record<string, string>): Promise<string> {
      const appError = (code: string) => `${endpoints.consentPage}?error=${code}`;
      const clientId = query.client_id;
      if (!clientId || clientId.length > 64) return appError('invalid_client');
      const db = getDb();
      const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId));
      if (!client || client.status !== 'active' || client.registration === 'builtin' || client.authMethod !== 'none') {
        return appError('invalid_client');
      }
      const redirectUri = query.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
      if (!redirectUri || !matchRedirectUri(client.redirectUris, redirectUri)) return appError('invalid_redirect_uri');

      const state = query.state && query.state.length <= 1024 ? query.state : null;
      // Errors go back to the client only when an admin vouched for its redirect URIs; anyone can
      // register a dynamic client, and this endpoint must not become an open redirector (RFC 9700 §4.11).
      const back = (error: string, description: string) =>
        client.registration === 'admin'
          ? withParams(redirectUri, { error, error_description: description, state, iss: endpoints.issuer })
          : appError(error);
      if (query.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code.');
      if (query.state && !state) return back('invalid_request', 'state is too long.');
      if (!query.code_challenge || !isPkceChallenge(query.code_challenge) || query.code_challenge_method !== 'S256') {
        return back('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
      }
      if (!isOurResource(endpoints, query.resource)) return back('invalid_target', 'Unknown resource.');
      const scopes = intersectScopes(requestedScopes(query.scope), client.allowedScopes);
      if (!scopes.length) return back('invalid_scope', 'Nothing this client asks for can be granted to it.');

      const handle = deps.tokens.newSecret();
      const pending: PendingRequest = {
        client_id: client.id,
        redirect_uri: redirectUri,
        scopes,
        state,
        code_challenge: query.code_challenge,
        member_id: null,
      };
      await db
        .delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, REQUESTS), lt(idempotencyKeys.expiresAt, new Date().toISOString())));
      await db.insert(idempotencyKeys).values({
        scope: REQUESTS,
        key: hash(handle, 'oauth_request'),
        requestHash: client.id,
        status: 'running',
        response: pending,
        expiresAt: inSeconds(REQUEST_TTL_SECONDS),
      });
      return `${endpoints.consentPage}?request=${handle}`;
    },

    /** `/oauth/token`: authorization_code, refresh_token and client_credentials. */
    async token(auth: ClientAuth): Promise<TokenResponse> {
      const grantType = auth.form.grant_type;
      if (!grantType) throw invalidRequest('grant_type is required.');
      const client = await authenticateClient(auth);
      const machine = client.authMethod === 'client_secret_post';
      const unauthorized = () =>
        new OAuthError(400, 'unauthorized_client', `This client cannot use grant_type=${grantType}.`);
      switch (grantType) {
        case 'authorization_code':
          if (machine) throw unauthorized();
          return exchangeCode(client, auth.form);
        case 'refresh_token':
          if (machine) throw unauthorized();
          return refresh(client, auth.form);
        case 'client_credentials':
          if (!machine) throw unauthorized();
          return clientCredentials(client, auth.form);
        default:
          throw new OAuthError(400, 'unsupported_grant_type', `grant_type=${grantType} is not supported.`);
      }
    },

    /**
     * `/oauth/revoke` (RFC 7009): a client revokes one of its own tokens; a refresh token takes
     * every token of its grant with it. Unknown tokens are not an error.
     */
    async revoke(auth: ClientAuth): Promise<void> {
      const client = await authenticateClient(auth);
      const raw = auth.form.token;
      if (!raw) throw invalidRequest('token is required.');
      if (raw.length > CREDENTIAL_MAX) return;
      await transaction(async (db) => {
        const [row] = await db
          .select({ token: oauthTokens, grant: oauthGrants })
          .from(oauthTokens)
          .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
          .where(eq(oauthTokens.tokenHash, hash(raw, 'oauth_token')));
        if (!row || row.grant.clientId !== client.id || row.token.kind === 'personal') return;
        if (row.token.kind === 'refresh') {
          await endCredentials(db, [row.grant.id]);
          return;
        }
        await db
          .update(oauthTokens)
          .set({ revokedAt: sql`now()` })
          .where(and(eq(oauthTokens.id, row.token.id), isNull(oauthTokens.revokedAt)));
      });
    },

    /**
     * The member a bearer token on `/api/mcp` acts for, or null. Read fresh on every request, like
     * requireMember: the token, its grant, its client and the member must all still be good.
     */
    async authenticate(raw: string): Promise<Caller | null> {
      const personal = raw.startsWith(PREFIX.personal);
      if (raw.length > CREDENTIAL_MAX || (!personal && !raw.startsWith(PREFIX.access))) return null;
      const [row] = await getDb()
        .select({ token: oauthTokens, grant: oauthGrants, client: oauthClients, member: members })
        .from(oauthTokens)
        .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
        .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
        .innerJoin(members, eq(members.id, oauthGrants.memberId))
        .where(eq(oauthTokens.tokenHash, hash(raw, 'oauth_token')));
      if (!row || row.token.kind !== (personal ? 'personal' : 'access')) return null;
      if (
        row.token.revokedAt ||
        expired(row.token.expiresAt) ||
        row.token.resource !== endpoints.resource ||
        row.token.authVersion !== row.member.authVersion ||
        row.member.status !== 'active' ||
        row.grant.status !== 'active' ||
        row.grant.resource !== endpoints.resource ||
        row.client.status !== 'active'
      ) {
        return null;
      }
      const scopes = intersectScopes(row.token.scopes, row.grant.scopes, row.client.allowedScopes);
      if (!scopes.length) return null;
      if (!row.token.lastUsedAt || Date.now() - Date.parse(row.token.lastUsedAt) > TOUCH_AFTER_MS) {
        await getDb()
          .update(oauthTokens)
          .set({ lastUsedAt: sql`now()` })
          .where(eq(oauthTokens.id, row.token.id));
      }
      return {
        memberId: row.member.id,
        clientId: row.client.id,
        clientName: row.client.name,
        grantId: row.grant.id,
        scopes,
      };
    },

    // --- The consent page ---

    /**
     * What the consent page shows. The first member to open a request owns it: a handle that
     * leaked afterwards is useless to anyone else.
     */
    async inspect(memberId: string, handle: string): Promise<ConsentRequest> {
      const db = getDb();
      const key = hash(handle, 'oauth_request');
      const live = and(
        eq(idempotencyKeys.scope, REQUESTS),
        eq(idempotencyKeys.key, key),
        gt(idempotencyKeys.expiresAt, new Date().toISOString()),
      );
      const [row] = await db.select().from(idempotencyKeys).where(live);
      const pending = row?.response as PendingRequest | undefined;
      if (!row || !pending) throw requestInvalid();
      if (pending.member_id === null) {
        const [claimed] = await db
          .update(idempotencyKeys)
          .set({ response: { ...pending, member_id: memberId } })
          .where(and(live, sql`${idempotencyKeys.response}->>'member_id' is null`))
          .returning();
        if (!claimed) return service.inspect(memberId, handle);
      } else if (pending.member_id !== memberId) {
        throw requestInvalid();
      }
      const client = await usableClient(db, pending.client_id, pending.redirect_uri);
      if (!client) throw conflict('client_unavailable', 'This app can no longer connect. Start again in the app.');
      const [grant] = await db
        .select()
        .from(oauthGrants)
        .where(
          and(
            eq(oauthGrants.memberId, memberId),
            eq(oauthGrants.clientId, client.id),
            eq(oauthGrants.resource, endpoints.resource),
            eq(oauthGrants.status, 'active'),
          ),
        );
      return {
        client: { id: client.id, name: client.name, registration: registrationOf(client) },
        redirect_uri: pending.redirect_uri,
        scopes: pending.scopes,
        granted_scopes: grant?.scopes ?? null,
        expires_at: row.expiresAt,
      };
    },

    /**
     * The member's decision. Spends the handle either way. Approving saves the grant with what
     * they ticked (never more than was asked) and hands the client a code for its redirect URI.
     */
    async decide(memberId: string, input: ConsentDecisionInput): Promise<{ redirect_to: string }> {
      return transaction(async (db) => {
        const [row] = await db
          .delete(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.scope, REQUESTS),
              eq(idempotencyKeys.key, hash(input.request, 'oauth_request')),
              gt(idempotencyKeys.expiresAt, new Date().toISOString()),
              or(
                sql`${idempotencyKeys.response}->>'member_id' is null`,
                sql`${idempotencyKeys.response}->>'member_id' = ${memberId}`,
              ),
            ),
          )
          .returning();
        const pending = row?.response as PendingRequest | undefined;
        if (!row || !pending) throw requestInvalid();
        const client = await usableClient(db, pending.client_id, pending.redirect_uri);
        if (!client) throw conflict('client_unavailable', 'This app can no longer connect. Start again in the app.');
        const back = (params: Record<string, string>) =>
          withParams(pending.redirect_uri, { ...params, state: pending.state, iss: endpoints.issuer });
        if (input.decision === 'deny') {
          return { redirect_to: back({ error: 'access_denied', error_description: 'The member declined.' }) };
        }
        const scopes = input.scopes ? orderScopes(input.scopes) : pending.scopes;
        if (!scopes.length || !isSubset(scopes, pending.scopes)) {
          throw invalidInput('Choose among the scopes this app asked for.');
        }
        const [member] = await db
          .select({ authVersion: members.authVersion })
          .from(members)
          .where(eq(members.id, memberId));
        const grant = await saveGrant(db, memberId, client.id, scopes, 'active');
        const code = newCredential('code');
        await db.insert(oauthCodes).values({
          codeHash: hash(code, 'oauth_code'),
          grantId: grant.id,
          redirectUri: pending.redirect_uri,
          codeChallenge: pending.code_challenge,
          scopes,
          authVersion: member!.authVersion,
          expiresAt: inSeconds(CODE_TTL_SECONDS),
        });
        await audit({
          actorId: memberId,
          clientId: client.id,
          action: 'oauth_grant.approve',
          resourceType: 'oauth_grant',
          resourceId: grant.id,
          summary: scopes.join(' '),
        });
        return { redirect_to: back({ code }) };
      });
    },

    // --- My grants ---

    /** Clients I authorized or that wait for my approval; personal tokens have their own list. */
    async grants(memberId: string, query: { cursor?: string; limit: number }): Promise<Page<Grant>> {
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select({ grant: oauthGrants, client: oauthClients })
        .from(oauthGrants)
        .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
        .where(
          and(
            eq(oauthGrants.memberId, memberId),
            inArray(oauthGrants.status, ['pending', 'active']),
            ne(oauthClients.registration, 'builtin'),
            before ? lt(oauthGrants.id, before) : undefined,
          ),
        )
        .orderBy(desc(oauthGrants.id))
        .limit(query.limit + 1);
      const activity = await grantActivity(rows.map((row) => row.grant.id));
      return toPage(
        rows.map((row) => ({ id: row.grant.id, ...row })),
        query.limit,
        (row) => toGrant(row.grant, row.client, activity.get(row.grant.id)),
      );
    },

    /** Revoking ends every token and code the grant gave. */
    async revokeGrant(memberId: string, grantId: string): Promise<void> {
      await transaction(async (db) => {
        const [grant] = await db
          .update(oauthGrants)
          .set({ status: 'revoked', revokedAt: sql`now()`, updatedAt: sql`now()` })
          .where(
            and(
              eq(oauthGrants.id, grantId),
              eq(oauthGrants.memberId, memberId),
              inArray(oauthGrants.status, ['pending', 'active']),
              ne(oauthGrants.clientId, PERSONAL_CLIENT_ID),
            ),
          )
          .returning();
        if (!grant) throw notFound('Authorization');
        await endCredentials(db, [grant.id]);
        await audit({
          actorId: memberId,
          clientId: grant.clientId,
          action: 'oauth_grant.revoke',
          resourceType: 'oauth_grant',
          resourceId: grant.id,
        });
      });
    },

    /** A machine client an admin bound to me starts acting as me. */
    async approveGrant(memberId: string, grantId: string): Promise<Grant> {
      return transaction(async (db) => {
        const [grant] = await db
          .update(oauthGrants)
          .set({ status: 'active', updatedAt: sql`now()` })
          .where(
            and(eq(oauthGrants.id, grantId), eq(oauthGrants.memberId, memberId), eq(oauthGrants.status, 'pending')),
          )
          .returning();
        if (!grant) throw notFound('Authorization');
        const [client] = await db.select().from(oauthClients).where(eq(oauthClients.id, grant.clientId));
        await audit({
          actorId: memberId,
          clientId: grant.clientId,
          action: 'oauth_grant.approve',
          resourceType: 'oauth_grant',
          resourceId: grant.id,
          summary: grant.scopes.join(' '),
        });
        return toGrant(grant, client!);
      });
    },

    // --- My personal access tokens ---

    async personalTokens(memberId: string, query: { cursor?: string; limit: number }): Promise<Page<PersonalToken>> {
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select({ token: oauthTokens })
        .from(oauthTokens)
        .innerJoin(oauthGrants, eq(oauthGrants.id, oauthTokens.grantId))
        .innerJoin(members, eq(members.id, oauthGrants.memberId))
        .where(
          and(
            eq(oauthGrants.memberId, memberId),
            eq(oauthGrants.clientId, PERSONAL_CLIENT_ID),
            eq(oauthTokens.kind, 'personal'),
            isNull(oauthTokens.revokedAt),
            // A password change ended the older ones.
            eq(oauthTokens.authVersion, members.authVersion),
            before ? lt(oauthTokens.id, before) : undefined,
          ),
        )
        .orderBy(desc(oauthTokens.id))
        .limit(query.limit + 1);
      return toPage(
        rows.map((row) => row.token),
        query.limit,
        toPersonal,
      );
    },

    /** A token for `/api/mcp` with the scopes and the lifetime I chose; shown once. */
    async createPersonalToken(memberId: string, input: CreatePersonalToken): Promise<CreatedPersonalToken> {
      return transaction(async (db) => {
        await db
          .insert(oauthClients)
          .values({
            id: PERSONAL_CLIENT_ID,
            name: 'Personal access tokens',
            authMethod: 'none',
            registration: 'builtin',
          })
          .onConflictDoNothing();
        const [member] = await db.select().from(members).where(eq(members.id, memberId));
        if (!member) throw notFound('Member');
        const [existing] = await db
          .select()
          .from(oauthGrants)
          .where(
            and(
              eq(oauthGrants.memberId, memberId),
              eq(oauthGrants.clientId, PERSONAL_CLIENT_ID),
              eq(oauthGrants.resource, endpoints.resource),
            ),
          )
          .for('update');
        if (existing) {
          const [{ n }] = (await db
            .select({ n: sql<number>`count(*)::int` })
            .from(oauthTokens)
            .where(
              and(
                eq(oauthTokens.grantId, existing.id),
                eq(oauthTokens.kind, 'personal'),
                isNull(oauthTokens.revokedAt),
                gt(oauthTokens.expiresAt, sql`now()`),
                eq(oauthTokens.authVersion, member.authVersion),
              ),
            )) as [{ n: number }];
          if (n >= MAX_PERSONAL_TOKENS) {
            throw conflict('too_many_tokens', `You can have ${MAX_PERSONAL_TOKENS} tokens; revoke one first.`);
          }
        }
        const scopes = orderScopes(input.scopes);
        const grantScopes = orderScopes([...(existing?.status === 'active' ? existing.scopes : []), ...scopes]);
        const grant = existing
          ? (
              await db
                .update(oauthGrants)
                .set({ scopes: grantScopes, status: 'active', revokedAt: null, updatedAt: sql`now()` })
                .where(eq(oauthGrants.id, existing.id))
                .returning()
            )[0]!
          : await saveGrant(db, memberId, PERSONAL_CLIENT_ID, grantScopes, 'active');
        const token = newCredential('personal');
        const [row] = await db
          .insert(oauthTokens)
          .values({
            id: newId('oauthToken'),
            grantId: grant.id,
            kind: 'personal',
            name: input.name,
            tokenHash: hash(token, 'oauth_token'),
            resource: endpoints.resource,
            scopes,
            authVersion: member.authVersion,
            expiresAt: inSeconds(input.expires_in_days * 24 * 60 * 60),
          })
          .returning();
        await prune(db, grant.id);
        await audit({
          actorId: memberId,
          action: 'personal_token.create',
          resourceType: 'oauth_token',
          resourceId: row!.id,
          summary: scopes.join(' '),
        });
        return { ...toPersonal(row!), token };
      });
    },

    async revokePersonalToken(memberId: string, tokenId: string): Promise<void> {
      await transaction(async (db) => {
        const [row] = await db
          .update(oauthTokens)
          .set({ revokedAt: sql`now()` })
          .where(
            and(
              eq(oauthTokens.id, tokenId),
              eq(oauthTokens.kind, 'personal'),
              isNull(oauthTokens.revokedAt),
              inArray(
                oauthTokens.grantId,
                db
                  .select({ id: oauthGrants.id })
                  .from(oauthGrants)
                  .where(and(eq(oauthGrants.memberId, memberId), eq(oauthGrants.clientId, PERSONAL_CLIENT_ID))),
              ),
            ),
          )
          .returning({ id: oauthTokens.id });
        if (!row) throw notFound('Token');
        await audit({
          actorId: memberId,
          action: 'personal_token.revoke',
          resourceType: 'oauth_token',
          resourceId: row.id,
        });
      });
    },

    // --- Admin: clients ---

    async clients(query: { cursor?: string; limit: number }): Promise<Page<AdminClient>> {
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select()
        .from(oauthClients)
        .where(and(ne(oauthClients.registration, 'builtin'), before ? lt(oauthClients.id, before) : undefined))
        .orderBy(desc(oauthClients.id))
        .limit(query.limit + 1);
      const more = rows.length > query.limit;
      const items = more ? rows.slice(0, query.limit) : rows;
      return { items: await adminViews(items), next_cursor: more ? encodeCursor(items[items.length - 1]!.id) : null };
    },

    client: adminView,

    /**
     * An interactive client with fixed redirect URIs, or a machine client bound to a member. A
     * machine client bound to someone else waits for that member's approval before it can act.
     */
    async createClient(adminId: string, input: CreateClientInput): Promise<CreatedClient> {
      const created = await transaction(async (db) => {
        if (input.kind === 'interactive') {
          const uris = redirectUris(input.redirect_uris);
          if (!uris) {
            throw invalidInput('Each redirect URI must be https, http on a loopback host, or an app scheme.');
          }
          const [row] = await db
            .insert(oauthClients)
            .values({
              id: newId('oauthClient'),
              name: input.name,
              redirectUris: uris,
              authMethod: 'none',
              allowedScopes: input.scopes ? orderScopes(input.scopes) : null,
              registration: 'admin',
              createdBy: adminId,
            })
            .returning();
          await audit({
            actorId: adminId,
            clientId: row!.id,
            action: 'oauth_client.create',
            resourceType: 'oauth_client',
            resourceId: row!.id,
            summary: 'interactive',
          });
          return { id: row!.id, secret: null };
        }
        const [member] = await db.select().from(members).where(eq(members.id, input.member_id));
        if (!member || member.status !== 'active') throw invalidInput('Choose an active member for this client.');
        const secret = newCredential('secret');
        const scopes = orderScopes(input.scopes);
        const [row] = await db
          .insert(oauthClients)
          .values({
            id: newId('oauthClient'),
            name: input.name,
            authMethod: 'client_secret_post',
            secretHash: hash(secret, 'oauth_secret'),
            boundMemberId: member.id,
            allowedScopes: scopes,
            registration: 'admin',
            createdBy: adminId,
          })
          .returning();
        await saveGrant(db, member.id, row!.id, scopes, member.id === adminId ? 'active' : 'pending');
        await audit({
          actorId: adminId,
          clientId: row!.id,
          action: 'oauth_client.create',
          resourceType: 'oauth_client',
          resourceId: row!.id,
          summary: 'machine',
        });
        return { id: row!.id, secret };
      });
      return { client: await adminView(created.id), client_secret: created.secret };
    },

    /** Rename, disable or enable. Disabling ends every token it holds at once. */
    async updateClient(adminId: string, clientId: string, input: UpdateClientInput): Promise<AdminClient> {
      await transaction(async (db) => {
        const [row] = await db
          .update(oauthClients)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            updatedAt: sql`now()`,
          })
          .where(and(eq(oauthClients.id, clientId), ne(oauthClients.registration, 'builtin')))
          .returning();
        if (!row) throw notFound('Client');
        if (input.status === 'disabled') {
          const grants = await db
            .select({ id: oauthGrants.id })
            .from(oauthGrants)
            .where(eq(oauthGrants.clientId, clientId));
          await endCredentials(
            db,
            grants.map((grant) => grant.id),
          );
        }
        await audit({
          actorId: adminId,
          clientId,
          action: 'oauth_client.update',
          resourceType: 'oauth_client',
          resourceId: clientId,
          summary: changedFields(input),
        });
      });
      return adminView(clientId);
    },

    /** A machine client's new secret, shown once; the old one and every token it got stop at once. */
    async rotateSecret(adminId: string, clientId: string): Promise<RotatedSecret> {
      const secret = newCredential('secret');
      await transaction(async (db) => {
        const [row] = await db
          .select()
          .from(oauthClients)
          .where(and(eq(oauthClients.id, clientId), ne(oauthClients.registration, 'builtin')))
          .for('update');
        if (!row) throw notFound('Client');
        if (row.authMethod !== 'client_secret_post') {
          throw conflict('not_a_machine_client', 'Only a machine client has a secret.');
        }
        await db
          .update(oauthClients)
          .set({ secretHash: hash(secret, 'oauth_secret'), updatedAt: sql`now()` })
          .where(eq(oauthClients.id, clientId));
        const grants = await db
          .select({ id: oauthGrants.id })
          .from(oauthGrants)
          .where(eq(oauthGrants.clientId, clientId));
        await endCredentials(
          db,
          grants.map((grant) => grant.id),
        );
        await audit({
          actorId: adminId,
          clientId,
          action: 'oauth_client.rotate_secret',
          resourceType: 'oauth_client',
          resourceId: clientId,
        });
      });
      return { client: await adminView(clientId), client_secret: secret };
    },

    /** Deletes the client with every grant, code and token it had. */
    async deleteClient(adminId: string, clientId: string): Promise<void> {
      await transaction(async (db) => {
        const deleted = await db
          .delete(oauthClients)
          .where(and(eq(oauthClients.id, clientId), ne(oauthClients.registration, 'builtin')))
          .returning({ id: oauthClients.id });
        if (!deleted.length) throw notFound('Client');
        await audit({
          actorId: adminId,
          clientId,
          action: 'oauth_client.delete',
          resourceType: 'oauth_client',
          resourceId: clientId,
        });
      });
    },
  };
  return service;
}

export type OAuthService = ReturnType<typeof createOAuthService>;
