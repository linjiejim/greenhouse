/**
 * E2E Tests — OAuth machine clients (client_credentials) for MCP
 *
 * Tests /api/admin/platform/oauth/* (super-only) + /oauth/token + /api/mcp:
 * - Machine client creation returns one-time client_secret
 * - Client list never exposes secrets or secret hashes
 * - client_credentials exchange yields a working MCP bearer (no refresh_token)
 * - Wrong/rotated secrets are rejected; rotation keeps the client working
 * - Disabling a client revokes outstanding tokens and blocks issuance
 * - Scope allowance is enforced at the token endpoint
 * - Legacy lpai_sk_* keys are rejected by /api/mcp
 *
 * Use `pnpm test:e2e:ci`; manual debugging setup is documented in tests/e2e/README.md.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSuperToken, createTestToken, BASE_URL } from './helpers.js';

let superToken: string;
let teamToken: string;
let teamUserId: string;
const clientsToClean: string[] = [];

function h(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const UNIQUE = Date.now().toString(36);
const ADMIN_BASE = `${BASE_URL}/api/admin/platform/oauth`;

async function createMachineClient(name: string, scopes: string[] = ['mcp:read']) {
  const res = await fetch(`${ADMIN_BASE}/machine-clients`, {
    method: 'POST',
    headers: h(superToken),
    body: JSON.stringify({ client_name: name, bound_user_id: teamUserId, scopes }),
  });
  expect(res.status).toBe(201);
  const data = await res.json();
  clientsToClean.push(data.client_id);
  return data as { client_id: string; client_secret: string; warning: string };
}

async function exchangeToken(clientId: string, clientSecret: string, scope?: string) {
  return fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      ...(scope ? { scope } : {}),
    }),
  });
}

async function mcpToolsList(accessToken: string) {
  return fetch(`${BASE_URL}/api/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`Server not running at ${BASE_URL}`);
  superToken = createSuperToken();

  const createUserRes = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: h(superToken),
    body: JSON.stringify({
      email: `e2e-oauth-machine-${UNIQUE}@test.local`,
      password: 'TestPass123!',
      nickname: 'E2E OAuth Machine User',
      role: 'team',
    }),
  });
  expect(createUserRes.status).toBe(201);
  const created = await createUserRes.json();
  teamUserId = created.user.id;
  teamToken = createTestToken(teamUserId, 'team');
});

afterAll(async () => {
  for (const id of clientsToClean) {
    await fetch(`${ADMIN_BASE}/clients/${id}`, { method: 'DELETE', headers: h(superToken) }).catch(() => {});
  }
  if (teamUserId) {
    await fetch(`${BASE_URL}/api/admin/users/${teamUserId}`, {
      method: 'DELETE',
      headers: h(superToken),
    }).catch(() => {});
  }
});

// ─── Machine client CRUD ─────────────────────────────────

describe('E2E: OAuth machine client CRUD', () => {
  it('creates a machine client and returns a one-time secret', async () => {
    const data = await createMachineClient(`e2e-create-${UNIQUE}`);
    expect(data.client_id).toMatch(/^lpoa_client_/);
    expect(data.client_secret).toMatch(/^lpoa_cs_/);
    expect(data.warning).toContain('not be shown again');
  });

  it('client list never exposes secrets or hashes', async () => {
    const res = await fetch(`${ADMIN_BASE}/clients`, { headers: h(superToken) });
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(await res.json());
    expect(serialized).not.toContain('lpoa_cs_');
    expect(serialized).not.toContain('client_secret_hash');
  });

  it('rejects an unknown bound user', async () => {
    const res = await fetch(`${ADMIN_BASE}/machine-clients`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({ client_name: 'bad', bound_user_id: 'no-such-user', scopes: ['mcp:read'] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects unsupported scopes', async () => {
    const res = await fetch(`${ADMIN_BASE}/machine-clients`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({ client_name: 'bad-scope', bound_user_id: teamUserId, scopes: ['mcp:admin'] }),
    });
    expect(res.status).toBe(400);
  });

  it('deletes a client', async () => {
    const data = await createMachineClient(`e2e-delete-${UNIQUE}`);
    const delRes = await fetch(`${ADMIN_BASE}/clients/${data.client_id}`, {
      method: 'DELETE',
      headers: h(superToken),
    });
    expect(delRes.status).toBe(200);
    const tokenRes = await exchangeToken(data.client_id, data.client_secret);
    expect(tokenRes.status).toBe(401);
  });
});

// ─── client_credentials exchange ─────────────────────────

describe('E2E: client_credentials token exchange', () => {
  it('exchanges the secret for a working MCP bearer without a refresh token', async () => {
    const data = await createMachineClient(`e2e-exchange-${UNIQUE}`);
    const tokenRes = await exchangeToken(data.client_id, data.client_secret);
    expect(tokenRes.status).toBe(200);
    const token = await tokenRes.json();
    expect(token.access_token).toMatch(/^lpoa_at_/);
    expect(token.refresh_token).toBeUndefined();
    // A read-only client also carries its resource-group scopes, so assert the
    // authority rather than an exact string that grows with the group roster.
    const scopes = new Set<string>(token.scope.split(' '));
    expect(scopes.has('mcp:read')).toBe(true);
    expect(scopes.has('mcp:write')).toBe(false);

    const mcpRes = await mcpToolsList(token.access_token);
    expect(mcpRes.status).toBe(200);
    const body = await mcpRes.json();
    expect(Array.isArray(body.result?.tools)).toBe(true);
  });

  it('rejects a wrong secret', async () => {
    const data = await createMachineClient(`e2e-wrong-${UNIQUE}`);
    const res = await exchangeToken(data.client_id, `lpoa_cs_${'x'.repeat(43)}`);
    expect(res.status).toBe(401);
  });

  it('rejects scopes beyond the client allowance', async () => {
    const data = await createMachineClient(`e2e-scope-${UNIQUE}`, ['mcp:read']);
    const res = await exchangeToken(data.client_id, data.client_secret, 'mcp:read mcp:write');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_scope');
  });
});

// ─── Rotation & revocation ───────────────────────────────

describe('E2E: secret rotation and revocation', () => {
  it('rotated secret works and the old secret is invalidated', async () => {
    const data = await createMachineClient(`e2e-rotate-${UNIQUE}`);
    const rotateRes = await fetch(`${ADMIN_BASE}/machine-clients/${data.client_id}/rotate-secret`, {
      method: 'POST',
      headers: h(superToken),
    });
    expect(rotateRes.status).toBe(200);
    const rotated = await rotateRes.json();
    expect(rotated.client_secret).toMatch(/^lpoa_cs_/);
    expect(rotated.client_secret).not.toBe(data.client_secret);

    const oldRes = await exchangeToken(data.client_id, data.client_secret);
    expect(oldRes.status).toBe(401);
    const newRes = await exchangeToken(data.client_id, rotated.client_secret);
    expect(newRes.status).toBe(200);
  });

  it('disabling a client revokes outstanding tokens and blocks issuance', async () => {
    const data = await createMachineClient(`e2e-disable-${UNIQUE}`);
    const tokenRes = await exchangeToken(data.client_id, data.client_secret);
    const token = await tokenRes.json();

    const disableRes = await fetch(`${ADMIN_BASE}/clients/${data.client_id}`, {
      method: 'PATCH',
      headers: h(superToken),
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(disableRes.status).toBe(200);

    const mcpRes = await mcpToolsList(token.access_token);
    expect(mcpRes.status).toBe(401);
    const reissueRes = await exchangeToken(data.client_id, data.client_secret);
    expect(reissueRes.status).toBe(401);
  });
});

// ─── Legacy keys & audit ─────────────────────────────────

describe('E2E: OAuth-only boundary', () => {
  it('rejects a legacy lpai_sk key on /api/mcp', async () => {
    const res = await fetch(`${BASE_URL}/api/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer lpai_sk_${'a'.repeat(64)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata');
  });

  it('retrieves per-client audit records', async () => {
    const data = await createMachineClient(`e2e-audit-${UNIQUE}`);
    const tokenRes = await exchangeToken(data.client_id, data.client_secret);
    const token = await tokenRes.json();
    await mcpToolsList(token.access_token);

    const res = await fetch(`${ADMIN_BASE}/clients/${data.client_id}/audit`, { headers: h(superToken) });
    expect(res.status).toBe(200);
    const audit = await res.json();
    expect(audit).toHaveProperty('records');
    expect(audit).toHaveProperty('total');
  });

  it('team user cannot manage OAuth clients (super-only)', async () => {
    const res = await fetch(`${ADMIN_BASE}/clients`, { headers: h(teamToken) });
    expect(res.status).toBe(403);
  });
});
