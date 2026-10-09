/**
 * Members' OAuth sign-ins to connectors, end to end against a real MCP server
 * behind a real (fixture) OAuth 2.1 authorization server — discovery, dynamic
 * registration, PKCE, the sealed state, code exchange, refresh with rotation,
 * revocation (spec 20261009-mcp-connectors D3–D5). The database is an
 * in-memory stand-in for the two services the flow touches.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseProvider, McpServerRow, ProviderTokenRow } from '@greenhouse/db';
import { decryptToken } from '../../auth/crypto.js';
import { callMcpTool } from '../client.js';
import { resolveConnectTarget } from '../credentials.js';
import {
  beginConnectorSignIn,
  ConnectorAuthorizationRequired,
  ConnectorSignInError,
  connectionAad,
  finishConnectorSignIn,
  manualClient,
  openSignInState,
  readStoredClient,
  revokeConnectorSignIn,
  sealSignInState,
  withConnectionLock,
} from '../oauth.js';
import { startMcpTestServer, type McpTestServer } from './fixture-server.js';

process.env.PROVIDER_TOKEN_ENCRYPTION_KEY ??= 'a'.repeat(64);

const REDIRECT = 'http://localhost:3100/api/connectors/oauth/callback';

function serverRow(over: Partial<McpServerRow>): McpServerRow {
  return {
    id: 41,
    slug: 'desk',
    name: 'Order desk',
    description: null,
    url: '',
    transport: 'streamable_http',
    auth_mode: 'oauth',
    auth_header: null,
    auth_query_param: null,
    auth_value_prefix: null,
    auth_value_encrypted: null,
    credential_help: null,
    credential_url: null,
    oauth_scope: null,
    oauth_client_encrypted: null,
    oauth_discovery: null,
    enabled: true,
    allowed_tools: null,
    read_only_tools: null,
    catalog_id: null,
    tools: [],
    tools_refreshed_at: null,
    last_error: null,
    created_by: null,
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    ...over,
  };
}

/** Just the services the flow uses, kept in memory. */
function memoryDb(initial: McpServerRow) {
  const state = { server: { ...initial } };
  const connections = new Map<string, ProviderTokenRow>();
  const users = new Map([
    ['u1', { id: 'u1', status: 'active', role: 'team', locale: 'en' }],
    ['u2', { id: 'u2', status: 'active', role: 'team', locale: 'zh' }],
    ['gone', { id: 'gone', status: 'disabled', role: 'team', locale: 'en' }],
  ]);
  const key = (userId: string, serverId: number) => `${userId}:${serverId}`;
  const db = {
    users: { getById: async (id: string) => users.get(id) },
    mcpServers: {
      getById: async (id: number) => (id === state.server.id ? state.server : undefined),
      setOAuthClient: async (_id: number, sealed: string | null) => {
        state.server = { ...state.server, oauth_client_encrypted: sealed };
      },
      setOAuthDiscovery: async (_id: number, discovery: Record<string, unknown> | null) => {
        state.server = { ...state.server, oauth_discovery: discovery };
      },
      getConnection: async (userId: string, serverId: number) => connections.get(key(userId, serverId)),
      saveConnection: async (userId: string, serverId: number, input: Record<string, unknown>) => {
        const row = {
          user_id: userId,
          provider: `mcp:${serverId}`,
          access_token: (input.access_token as string | null) ?? null,
          refresh_token: (input.refresh_token as string | null) ?? null,
          token_type: (input.token_type as string) ?? 'Bearer',
          scope: (input.scope as string | null) ?? null,
          expires_at: (input.expires_at as string | null) ?? null,
          provider_credential: (input.credential as string | null) ?? null,
          metadata: JSON.stringify(input.metadata ?? {}),
          updated_at: new Date().toISOString(),
        } as unknown as ProviderTokenRow;
        connections.set(key(userId, serverId), row);
        return row;
      },
      updateConnectionTokens: async (
        userId: string,
        serverId: number,
        expected: string | null,
        tokens: Record<string, unknown>,
      ) => {
        const row = connections.get(key(userId, serverId));
        if (!row || row.access_token !== expected) return false;
        for (const [k, v] of Object.entries(tokens)) if (v !== undefined) (row as Record<string, unknown>)[k] = v;
        return true;
      },
      expireConnection: async (userId: string, serverId: number, reason: string) => {
        const row = connections.get(key(userId, serverId));
        if (row)
          Object.assign(row, { access_token: null, refresh_token: null, metadata: JSON.stringify({ error: reason }) });
      },
    },
  };
  return { state, connections, db: db as unknown as DatabaseProvider };
}

/** Play the browser: follow the authorization URL to the redirect and read code + state. */
async function authorize(url: string): Promise<{ code: string; state: string }> {
  const res = await fetch(url, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get('location')!);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  return { code: back.searchParams.get('code')!, state: back.searchParams.get('state')! };
}

async function signIn(store: ReturnType<typeof memoryDb>, userId: string) {
  const url = await beginConnectorSignIn(store.db, store.state.server, userId, REDIRECT);
  const { code, state } = await authorize(url);
  return finishConnectorSignIn(store.db, { code, state });
}

async function whoami(store: ReturnType<typeof memoryDb>, userId: string): Promise<string> {
  const resolved = await resolveConnectTarget(store.db, store.state.server, userId);
  if (!resolved.ok) throw new Error(resolved.error);
  const outcome = await withConnectionLock(store.state.server.id, userId, () =>
    callMcpTool(resolved.target, 'whoami', {}),
  );
  return outcome.text;
}

let server: McpTestServer;

beforeAll(async () => {
  server = await startMcpTestServer({ oauth: {} });
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  delete process.env.PUBLIC_BASE_URL;
});

describe('a member signs in to an OAuth connector', () => {
  it('discovers, registers once for the instance and sends the member to the provider with PKCE + resource', async () => {
    const store = memoryDb(serverRow({ url: server.url }));
    const url = new URL(await beginConnectorSignIn(store.db, store.state.server, 'u1', REDIRECT));

    expect(`${url.origin}${url.pathname}`).toBe(`${server.origin}/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(server.url);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    // The scope the server's challenge asked for.
    expect(url.searchParams.get('scope')).toBe('tickets');

    const client = readStoredClient(store.state.server)!;
    expect(client).toMatchObject({ source: 'dynamic', redirect_uri: REDIRECT });
    expect(url.searchParams.get('client_id')).toBe(client.client_id);
    expect(server.oauth!.clients.has(client.client_id)).toBe(true);
    // Discovery is cached on the connector (public metadata, not a secret).
    expect(store.state.server.oauth_discovery).toMatchObject({ authorizationServerUrl: server.origin });

    // The state is sealed (encrypted, not merely encoded): it names the member,
    // the connector and the PKCE verifier without showing any of them.
    const raw = url.searchParams.get('state')!;
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).not.toContain('"u":');
    expect(decoded).not.toContain('"v":');
    expect(openSignInState(raw)).toMatchObject({ u: 'u1', s: 41, r: REDIRECT });
  });

  it('the callback stores encrypted tokens for the member named in the state, and calls carry them', async () => {
    const store = memoryDb(serverRow({ url: server.url }));
    server.oauth!.nextSubject = 'alice';
    const result = await signIn(store, 'u1');
    expect(result.userId).toBe('u1');

    const row = store.connections.get('u1:41')!;
    expect(row.access_token).toBeTruthy();
    expect(row.access_token).not.toMatch(/^at_/);
    expect(decryptToken(row.access_token!, connectionAad(41, 'u1', 'access'))).toMatch(/^at_/);
    // Bound to its place: the same ciphertext does not open as another member's.
    expect(() => decryptToken(row.access_token!, connectionAad(41, 'u2', 'access'))).toThrow();

    expect(await whoami(store, 'u1')).toBe('You are alice');
    // u2 never signed in — and u1's sign-in is not theirs.
    expect(await resolveConnectTarget(store.db, store.state.server, 'u2')).toMatchObject({
      ok: false,
      reason: 'not_connected',
    });
  });

  it('refreshes an expired token once, even when two calls hit it at the same moment', async () => {
    const store = memoryDb(serverRow({ url: server.url }));
    await signIn(store, 'u1');
    const before = server.oauth!.refreshCount;
    server.oauth!.expireAccessTokens();

    const [a, b] = await Promise.all([whoami(store, 'u1'), whoami(store, 'u1')]);
    expect(a).toBe('You are alice');
    expect(b).toBe('You are alice');
    expect(server.oauth!.refreshCount).toBe(before + 1);
  });

  it('a refused refresh ends the sign-in: the call says reconnect, the connection shows why', async () => {
    const store = memoryDb(serverRow({ url: server.url }));
    await signIn(store, 'u1');
    server.oauth!.expireAccessTokens();
    server.oauth!.revokeRefreshTokens();

    await expect(whoami(store, 'u1')).rejects.toBeInstanceOf(ConnectorAuthorizationRequired);
    const row = store.connections.get('u1:41')!;
    expect(row.access_token).toBeNull();
    expect(JSON.parse(row.metadata)).toMatchObject({ error: expect.stringContaining('no longer accepts') });
    expect(await resolveConnectTarget(store.db, store.state.server, 'u1')).toMatchObject({
      ok: false,
      reason: 'expired',
    });
  });

  it("registers again when the instance's callback address moved", async () => {
    const store = memoryDb(serverRow({ url: server.url }));
    await beginConnectorSignIn(store.db, store.state.server, 'u1', REDIRECT);
    const first = readStoredClient(store.state.server)!.client_id;
    const moved = 'http://127.0.0.1:4420/api/connectors/oauth/callback';
    await beginConnectorSignIn(store.db, store.state.server, 'u1', moved);
    const second = readStoredClient(store.state.server)!;
    expect(second.client_id).not.toBe(first);
    expect(second.redirect_uri).toBe(moved);
  });

  it('disconnecting revokes the refresh token at the provider', async () => {
    const store = memoryDb(serverRow({ url: server.url }));
    await signIn(store, 'u1');
    const row = store.connections.get('u1:41')!;
    const refresh = decryptToken(row.refresh_token!, connectionAad(41, 'u1', 'refresh'));
    await revokeConnectorSignIn(store.state.server, 'u1', row);
    expect(server.oauth!.revoked).toContain(refresh);
  });
});

describe('the callback refuses what it should', () => {
  it('a tampered, expired or foreign state', async () => {
    const store = memoryDb(serverRow({ url: server.url }));
    const url = await beginConnectorSignIn(store.db, store.state.server, 'u1', REDIRECT);
    const { code, state } = await authorize(url);

    const tampered = state.slice(0, -4) + (state.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await expect(finishConnectorSignIn(store.db, { code, state: tampered })).rejects.toBeInstanceOf(
      ConnectorSignInError,
    );
    const expired = sealSignInState({ u: 'u1', s: 41, v: 'x'.repeat(43), r: REDIRECT }, -1);
    await expect(finishConnectorSignIn(store.db, { code, state: expired })).rejects.toThrow(/invalid or expired/);
    await expect(finishConnectorSignIn(store.db, { code, state: 'not-a-state' })).rejects.toThrow(/invalid or expired/);
    expect(store.connections.size).toBe(0);
  });

  it('a member disabled while on the consent page', async () => {
    const store = memoryDb(serverRow({ url: server.url }));
    const url = await beginConnectorSignIn(store.db, store.state.server, 'gone', REDIRECT);
    const { code, state } = await authorize(url);
    await expect(finishConnectorSignIn(store.db, { code, state })).rejects.toThrow(/can no longer connect/);
  });

  it('a code replayed after it was used', async () => {
    const store = memoryDb(serverRow({ url: server.url }));
    const url = await beginConnectorSignIn(store.db, store.state.server, 'u1', REDIRECT);
    const { code, state } = await authorize(url);
    await finishConnectorSignIn(store.db, { code, state });
    await expect(finishConnectorSignIn(store.db, { code, state })).rejects.toBeInstanceOf(ConnectorSignInError);
  });
});

describe('client identity', () => {
  it('without dynamic registration, a client the admin entered by hand is used', async () => {
    const manual = await startMcpTestServer({ oauth: { dynamicRegistration: false } });
    try {
      const store = memoryDb(serverRow({ url: manual.url }));
      await expect(beginConnectorSignIn(store.db, store.state.server, 'u1', REDIRECT)).rejects.toBeInstanceOf(
        ConnectorSignInError,
      );

      manual.oauth!.preRegister('gh-app-1', REDIRECT);
      store.state.server = { ...store.state.server, oauth_client_encrypted: manualClient(41, 'gh-app-1') };
      const url = new URL(await beginConnectorSignIn(store.db, store.state.server, 'u1', REDIRECT));
      expect(url.searchParams.get('client_id')).toBe('gh-app-1');
      const { code, state } = await authorize(url.toString());
      await finishConnectorSignIn(store.db, { code, state });
      expect(store.connections.get('u1:41')?.access_token).toBeTruthy();
    } finally {
      await manual.close();
    }
  });

  it('with an https public address and a server that accepts it, a client-id metadata document instead of registering', async () => {
    const cimd = await startMcpTestServer({ oauth: { metadataDocuments: true } });
    process.env.PUBLIC_BASE_URL = 'https://greenhouse.example.com';
    try {
      const store = memoryDb(serverRow({ url: cimd.url }));
      const url = new URL(await beginConnectorSignIn(store.db, store.state.server, 'u1', REDIRECT));
      expect(url.searchParams.get('client_id')).toBe(
        'https://greenhouse.example.com/api/connectors/oauth/client-metadata.json',
      );
      expect(readStoredClient(store.state.server)?.source).toBe('metadata_document');
      expect(cimd.oauth!.clients.size).toBe(0);
    } finally {
      await cimd.close();
    }
  });

  it('a server that answers without asking for a sign-in is not an OAuth server', async () => {
    const open = await startMcpTestServer();
    try {
      const store = memoryDb(serverRow({ url: open.url }));
      await expect(beginConnectorSignIn(store.db, store.state.server, 'u1', REDIRECT)).rejects.toThrow(
        /without asking for a sign-in/,
      );
    } finally {
      await open.close();
    }
  });
});
