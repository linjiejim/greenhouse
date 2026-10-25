/**
 * OAuth sign-ins to connectors, end to end against a real MCP server behind a
 * real (fixture) OAuth 2.1 authorization server and the real database:
 * discovery, dynamic registration, PKCE + resource, the sealed state, finish
 * only by the member who started it, refresh with rotation (one refresh for
 * concurrent calls, compare-and-set), invalid_grant → needs_reauth,
 * invalid_client → re-register, revocation, the team's shared sign-in.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetProvider,
  initDatabase,
  type DatabaseProvider,
  type McpConnectorRow,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { decryptToken } from '../../auth/crypto.js';
import { callMcpTool } from '../client.js';
import { resolveConnectTarget } from '../credentials.js';
import {
  beginConnectorSignIn,
  ConnectorAuthorizationRequired,
  ConnectorSignInError,
  connectionAad,
  finishConnectorSignIn,
  openSignInState,
  readStoredClient,
  revokeMemberSignIn,
  sealManualClient,
  sealSignInState,
  withSignInLock,
  type SignInOwner,
} from '../oauth.js';
import { startMcpTestServer, type McpTestServer } from './fixture-server.js';

process.env.PROVIDER_TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);

const REDIRECT = 'http://localhost:3100/api/connectors/oauth/callback';

let server: McpTestServer;
let db: DatabaseProvider;
let alice: UserRow;
let bob: UserRow;
let admin: UserRow;

const unique = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  server = await startMcpTestServer({ oauth: {} });
});
afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  alice = await createInternalTestUser(db, { email: `${unique('oa')}@test.local` });
  bob = await createInternalTestUser(db, { email: `${unique('ob')}@test.local` });
  admin = await createInternalTestUser(db, { email: `${unique('os')}@test.local`, role: 'super' });
  server.oauth!.nextSubject = 'alice';
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

function connector(url = server.url, over: Partial<Parameters<DatabaseProvider['mcpConnectors']['create']>[0]> = {}) {
  return db.mcpConnectors.create({
    scope: 'team',
    slug: `d${Math.random().toString(36).slice(2, 9)}`,
    name: 'Order desk',
    url,
    auth_mode: 'per_member',
    auth_kind: 'oauth',
    ...over,
  });
}

const fresh = async (row: McpConnectorRow) => (await db.mcpConnectors.getById(row.id))!;

/** Play the browser: follow the authorization URL to the redirect and read code + state. */
async function authorize(url: string): Promise<{ code: string; state: string }> {
  const res = await fetch(url, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get('location')!);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  return { code: back.searchParams.get('code')!, state: back.searchParams.get('state')! };
}

async function signIn(row: McpConnectorRow, user: UserRow, owner: SignInOwner = { kind: 'member', userId: user.id }) {
  const url = await beginConnectorSignIn(db, await fresh(row), {
    owner,
    actorUserId: user.id,
    redirectUri: REDIRECT,
    client: 'web',
  });
  const { code, state } = await authorize(url);
  return finishConnectorSignIn(db, { code, state, caller: { id: user.id, role: user.role } });
}

async function whoami(row: McpConnectorRow, userId: string): Promise<string> {
  const resolved = await resolveConnectTarget(db, await fresh(row), userId);
  if (!resolved.ok) throw new Error(resolved.error);
  const outcome = await withSignInLock(row.id, resolved.owner!, () => callMcpTool(resolved.target, 'whoami', {}));
  return outcome.text;
}

describe('a member signs in to an OAuth connector', () => {
  it('discovers, registers once for the instance and sends the member to the provider with PKCE + resource', async () => {
    const row = await connector();
    const url = new URL(
      await beginConnectorSignIn(db, row, {
        owner: { kind: 'member', userId: alice.id },
        actorUserId: alice.id,
        redirectUri: REDIRECT,
        client: 'mobile',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(`${server.origin}/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(server.url);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toBe('tickets');

    const stored = await fresh(row);
    const client = readStoredClient(stored)!;
    expect(client).toMatchObject({ source: 'dynamic', redirect_uri: REDIRECT });
    expect(url.searchParams.get('client_id')).toBe(client.client_id);
    expect(stored.oauth_discovery).toMatchObject({ authorizationServerUrl: server.origin });

    // Sealed, not merely encoded.
    const raw = url.searchParams.get('state')!;
    expect(Buffer.from(raw, 'base64url').toString('utf8')).not.toContain('"v":');
    expect(openSignInState(raw)).toMatchObject({ u: alice.id, s: row.id, r: REDIRECT, sh: 0, c: 'mobile' });
  });

  it('finish stores AAD-bound tokens for the member, and calls carry them', async () => {
    const row = await connector();
    const result = await signIn(row, alice);
    expect(result.owner).toEqual({ kind: 'member', userId: alice.id });

    const conn = (await db.mcpConnectors.getConnection(alice.id, row.id))!;
    expect(conn.access_token_enc).not.toMatch(/^at_/);
    expect(decryptToken(conn.access_token_enc!, connectionAad(row.id, alice.id, 'access'))).toMatch(/^at_/);
    expect(() => decryptToken(conn.access_token_enc!, connectionAad(row.id, bob.id, 'access'))).toThrow();
    expect(conn.metadata).toMatchObject({ status: 'active', connected_via: 'oauth' });

    expect(await whoami(row, alice.id)).toBe('You are alice');
    expect(await resolveConnectTarget(db, await fresh(row), bob.id)).toMatchObject({
      ok: false,
      reason: 'not_connected',
    });
  });

  it('refreshes an expired token once, even when two calls hit it at the same moment', async () => {
    const row = await connector();
    await signIn(row, alice);
    const before = server.oauth!.refreshCount;
    server.oauth!.expireAccessTokens();
    const [a, b] = await Promise.all([whoami(row, alice.id), whoami(row, alice.id)]);
    expect([a, b]).toEqual(['You are alice', 'You are alice']);
    expect(server.oauth!.refreshCount).toBe(before + 1);
  });

  it('a refused refresh (invalid_grant) marks the sign-in needs_reauth', async () => {
    const row = await connector();
    await signIn(row, alice);
    server.oauth!.expireAccessTokens();
    server.oauth!.revokeRefreshTokens();
    await expect(whoami(row, alice.id)).rejects.toBeInstanceOf(ConnectorAuthorizationRequired);
    const conn = (await db.mcpConnectors.getConnection(alice.id, row.id))!;
    expect(conn.metadata).toMatchObject({ status: 'needs_reauth' });
    expect(await resolveConnectTarget(db, await fresh(row), alice.id)).toMatchObject({
      ok: false,
      reason: 'needs_reauth',
    });
  });

  it('invalid_client drops a registered client so the next sign-in registers again; a manual one is kept', async () => {
    const row = await connector();
    await signIn(row, alice);
    const first = readStoredClient(await fresh(row))!.client_id;
    server.oauth!.expireAccessTokens();
    server.oauth!.forgetClients();
    await expect(whoami(row, alice.id)).rejects.toBeInstanceOf(Error);
    expect(readStoredClient(await fresh(row))).toBeNull();
    await signIn(row, alice);
    expect(readStoredClient(await fresh(row))!.client_id).not.toBe(first);

    const manual = await connector(server.url, { oauth_client_enc: null });
    server.oauth!.preRegister('manual-app', REDIRECT);
    await db.mcpConnectors.setOAuthClient(manual.id, sealManualClient(manual.id, 'manual-app'));
    await signIn(manual, alice);
    server.oauth!.expireAccessTokens();
    server.oauth!.forgetClients();
    await expect(whoami(manual, alice.id)).rejects.toBeInstanceOf(Error);
    expect(readStoredClient(await fresh(manual))).toMatchObject({ client_id: 'manual-app', source: 'manual' });
  });

  it("registers again when the instance's callback address moved", async () => {
    const row = await connector();
    const begin = (redirectUri: string) =>
      beginConnectorSignIn(db, row, {
        owner: { kind: 'member', userId: alice.id },
        actorUserId: alice.id,
        redirectUri,
        client: 'web',
      });
    await begin(REDIRECT);
    const first = readStoredClient(await fresh(row))!.client_id;
    const moved = 'http://127.0.0.1:4420/api/connectors/oauth/callback';
    const latest = await fresh(row);
    await beginConnectorSignIn(db, latest, {
      owner: { kind: 'member', userId: alice.id },
      actorUserId: alice.id,
      redirectUri: moved,
      client: 'web',
    });
    const second = readStoredClient(await fresh(row))!;
    expect(second.client_id).not.toBe(first);
    expect(second.redirect_uri).toBe(moved);
  });

  it('disconnecting revokes the refresh token at the provider', async () => {
    const row = await connector();
    await signIn(row, alice);
    const conn = (await db.mcpConnectors.getConnection(alice.id, row.id))!;
    const refresh = decryptToken(conn.refresh_token_enc!, connectionAad(row.id, alice.id, 'refresh'));
    expect(await revokeMemberSignIn(await fresh(row), alice.id, conn)).toBe(true);
    expect(server.oauth!.revoked).toContain(refresh);
  });
});

describe('finish refuses what it should', () => {
  it('a tampered, expired or foreign-purpose state', async () => {
    const row = await connector();
    const url = await beginConnectorSignIn(db, row, {
      owner: { kind: 'member', userId: alice.id },
      actorUserId: alice.id,
      redirectUri: REDIRECT,
      client: 'web',
    });
    const { code, state } = await authorize(url);
    const caller = { id: alice.id, role: 'team' };
    const tampered = state.slice(0, -4) + (state.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await expect(finishConnectorSignIn(db, { code, state: tampered, caller })).rejects.toBeInstanceOf(
      ConnectorSignInError,
    );
    const expired = sealSignInState({ u: alice.id, s: row.id, v: 'x'.repeat(43), r: REDIRECT, sh: 0, c: 'web' }, -1);
    await expect(finishConnectorSignIn(db, { code, state: expired, caller })).rejects.toThrow(/invalid or expired/);
    await expect(finishConnectorSignIn(db, { code, state: 'not-a-state', caller })).rejects.toThrow(
      /invalid or expired/,
    );
    expect(await db.mcpConnectors.getConnection(alice.id, row.id)).toBeUndefined();
  });

  it('a state started by someone else — the link is useless to whoever intercepts it', async () => {
    const row = await connector();
    const url = await beginConnectorSignIn(db, row, {
      owner: { kind: 'member', userId: alice.id },
      actorUserId: alice.id,
      redirectUri: REDIRECT,
      client: 'web',
    });
    const { code, state } = await authorize(url);
    await expect(
      finishConnectorSignIn(db, { code, state, caller: { id: bob.id, role: 'team' } }),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(await db.mcpConnectors.getConnection(bob.id, row.id)).toBeUndefined();
    expect(await db.mcpConnectors.getConnection(alice.id, row.id)).toBeUndefined();
  });

  it('a code replayed after it was used', async () => {
    const row = await connector();
    const url = await beginConnectorSignIn(db, row, {
      owner: { kind: 'member', userId: alice.id },
      actorUserId: alice.id,
      redirectUri: REDIRECT,
      client: 'web',
    });
    const { code, state } = await authorize(url);
    await finishConnectorSignIn(db, { code, state, caller: { id: alice.id, role: 'team' } });
    await expect(
      finishConnectorSignIn(db, { code, state, caller: { id: alice.id, role: 'team' } }),
    ).rejects.toBeInstanceOf(ConnectorSignInError);
  });

  it('a server that answers without asking for a sign-in is not an OAuth server', async () => {
    const open = await startMcpTestServer();
    try {
      const row = await connector(open.url);
      await expect(
        beginConnectorSignIn(db, row, {
          owner: { kind: 'member', userId: alice.id },
          actorUserId: alice.id,
          redirectUri: REDIRECT,
          client: 'web',
        }),
      ).rejects.toThrow(/without asking for a sign-in/);
    } finally {
      await open.close();
    }
  });
});

describe("the team's shared sign-in", () => {
  it('a super signs in once; every member calls as that account; a team member cannot finish one', async () => {
    const row = await connector(server.url, { auth_mode: 'shared' });
    server.oauth!.nextSubject = 'team-bot';
    await signIn(row, admin, { kind: 'shared' });
    const stored = await fresh(row);
    expect(stored.shared_secret_enc).toBeTruthy();
    expect(await whoami(row, alice.id)).toBe('You are team-bot');
    expect(await whoami(row, bob.id)).toBe('You are team-bot');

    const url = await beginConnectorSignIn(db, stored, {
      owner: { kind: 'shared' },
      actorUserId: alice.id,
      redirectUri: REDIRECT,
      client: 'web',
    });
    const { code, state } = await authorize(url);
    await expect(
      finishConnectorSignIn(db, { code, state, caller: { id: alice.id, role: 'team' } }),
    ).rejects.toMatchObject({
      status: 403,
    });
  });
});
