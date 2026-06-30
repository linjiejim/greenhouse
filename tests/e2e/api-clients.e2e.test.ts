/**
 * E2E Tests — API Client Management
 *
 * Tests /api/admin/clients CRUD (super-only):
 * - Client creation returns one-time key
 * - Client list doesn't expose raw keys
 * - Key rotation invalidates old key
 * - Client deletion
 * - Usage and audit retrieval
 *
 * Run manually:
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm vitest run tests/e2e/api-clients.e2e.test.ts --config vitest.e2e.config.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestToken, BASE_URL, PASSWORD } from './helpers.js';

let superToken: string;
let adminToken: string;
const clientsToClean: string[] = [];

function h(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const UNIQUE = Date.now().toString(36);

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`Server not running at ${BASE_URL}`);
  superToken = createTestToken('e2e-client-super', 'super');
  adminToken = createTestToken('e2e-client-admin', 'admin');
});

afterAll(async () => {
  for (const id of clientsToClean) {
    await fetch(`${BASE_URL}/api/admin/clients/${id}`, {
      method: 'DELETE',
      headers: h(superToken),
    }).catch(() => {});
  }
});

// ─── Client CRUD ─────────────────────────────────────────

describe('E2E: API Client CRUD', () => {
  it('creates client and returns one-time API key', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/clients`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({
        app_id: `e2e-client-${UNIQUE}`,
        app_name: `E2E Client ${UNIQUE}`,
        allowed_profiles: ['default'],
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.api_key).toMatch(/^gh_sk_/);
    expect(data.warning).toContain('not be shown again');
    expect(data.client.app_id).toBe(`e2e-client-${UNIQUE}`);
    clientsToClean.push(data.client.id);
  });

  it('client list does not expose raw API keys', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/clients`, {
      headers: h(superToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const serialized = JSON.stringify(data);
    // Should never contain raw key values
    expect(serialized).not.toContain('gh_sk_');
  });

  it('rejects duplicate app_id', async () => {
    const appId = `e2e-dup-${UNIQUE}`;
    const first = await fetch(`${BASE_URL}/api/admin/clients`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({ app_id: appId, app_name: 'First' }),
    });
    const firstData = await first.json();
    clientsToClean.push(firstData.client.id);

    const dup = await fetch(`${BASE_URL}/api/admin/clients`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({ app_id: appId, app_name: 'Duplicate' }),
    });
    expect(dup.status).toBe(409);
  });

  it('rejects invalid app_id format', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/clients`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({ app_id: 'INVALID APP ID!', app_name: 'Bad ID' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('app_id');
  });

  it('gets client detail with usage', async () => {
    const createRes = await fetch(`${BASE_URL}/api/admin/clients`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({
        app_id: `e2e-detail-${UNIQUE}`,
        app_name: 'Detail Client',
      }),
    });
    const created = await createRes.json();
    clientsToClean.push(created.client.id);

    const res = await fetch(`${BASE_URL}/api/admin/clients/${created.client.id}`, {
      headers: h(superToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.client.app_id).toBe(`e2e-detail-${UNIQUE}`);
    expect(data).toHaveProperty('usage');
  });

  it('updates client configuration', async () => {
    const createRes = await fetch(`${BASE_URL}/api/admin/clients`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({
        app_id: `e2e-update-${UNIQUE}`,
        app_name: 'Update Client',
        rate_limit_rpm: 10,
      }),
    });
    const created = await createRes.json();
    clientsToClean.push(created.client.id);

    const res = await fetch(`${BASE_URL}/api/admin/clients/${created.client.id}`, {
      method: 'PUT',
      headers: h(superToken),
      body: JSON.stringify({ rate_limit_rpm: 100, status: 'active' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.client.rate_limit_rpm).toBe(100);
  });

  it('deletes client', async () => {
    const createRes = await fetch(`${BASE_URL}/api/admin/clients`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({
        app_id: `e2e-delete-${UNIQUE}`,
        app_name: 'Delete Client',
      }),
    });
    const created = await createRes.json();

    const delRes = await fetch(`${BASE_URL}/api/admin/clients/${created.client.id}`, {
      method: 'DELETE',
      headers: h(superToken),
    });
    expect(delRes.status).toBe(200);
    const data = await delRes.json();
    expect(data.ok).toBe(true);
  });
});

// ─── Key Rotation ────────────────────────────────────────

describe('E2E: API Key Rotation', () => {
  it('rotated key works and old key is invalidated', async () => {
    const createRes = await fetch(`${BASE_URL}/api/admin/clients`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({
        app_id: `e2e-rotate-${UNIQUE}`,
        app_name: 'Rotate Client',
        allowed_profiles: ['default'],
      }),
    });
    const created = await createRes.json();
    clientsToClean.push(created.client.id);
    const oldKey = created.api_key;

    // Rotate the key
    const rotateRes = await fetch(`${BASE_URL}/api/admin/clients/${created.client.id}/rotate-key`, {
      method: 'POST',
      headers: h(superToken),
    });
    expect(rotateRes.status).toBe(200);
    const rotated = await rotateRes.json();
    expect(rotated.api_key).toMatch(/^gh_sk_/);
    expect(rotated.api_key).not.toBe(oldKey);

    // Old key should fail
    const oldRes = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${oldKey}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
    });
    expect(oldRes.status).toBe(401);

    // New key should work (not 401)
    const newRes = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rotated.api_key}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] }),
    });
    expect(newRes.status).not.toBe(401);
  });
});

// ─── Usage & Audit ───────────────────────────────────────

describe('E2E: Client Usage & Audit', () => {
  it('retrieves client usage', async () => {
    const createRes = await fetch(`${BASE_URL}/api/admin/clients`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({
        app_id: `e2e-usage-${UNIQUE}`,
        app_name: 'Usage Client',
      }),
    });
    const created = await createRes.json();
    clientsToClean.push(created.client.id);

    const res = await fetch(`${BASE_URL}/api/admin/clients/${created.client.id}/usage`, {
      headers: h(superToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('app_id');
    expect(data).toHaveProperty('today_tokens');
  });

  it('retrieves client audit log', async () => {
    const createRes = await fetch(`${BASE_URL}/api/admin/clients`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({
        app_id: `e2e-audit-${UNIQUE}`,
        app_name: 'Audit Client',
      }),
    });
    const created = await createRes.json();
    clientsToClean.push(created.client.id);

    const res = await fetch(`${BASE_URL}/api/admin/clients/${created.client.id}/audit`, {
      headers: h(superToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('records');
    expect(data).toHaveProperty('total');
  });
});

// ─── Auth Requirements ───────────────────────────────────

describe('E2E: Client Admin Auth', () => {
  it('admin user cannot manage clients (super-only)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/clients`, {
      headers: h(adminToken),
    });
    // /api/admin/* requires super
    expect(res.status).toBe(403);
  });
});
