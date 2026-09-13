/**
 * E2E Tests — Agent Tool Proxy (/api/agent/*)
 *
 * Exercises the full cloud capability chain against a live server + DB:
 * - logged-in internal user bearer auth
 * - runtime-manifest discovery (proxy allowlists ∩ user tools)
 * - tool call returns structured output
 * - non-allowlisted / mutating tools are gated
 * - auth boundary: no token / external token / old API-key token are rejected
 *
 * Use `pnpm test:e2e:ci`; manual debugging setup is documented in tests/e2e/README.md.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSuperToken, createTestToken, BASE_URL, authHeaders as h } from './helpers.js';

let superToken: string;
let memberToken: string;
let externalToken: string;
let memberId: string;

const UNIQUE = Date.now().toString(36);

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`Server not running at ${BASE_URL}`);

  superToken = createSuperToken();
  externalToken = createTestToken('e2e-agent-external', 'external');

  // Create a real DB member user — /api/agent validates current user status/role.
  const email = `e2e-agent-member-${UNIQUE}@test.local`;
  const createRes = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: h(superToken),
    body: JSON.stringify({ email, password: 'TestPass123!', nickname: 'Agent Test Member' }),
  });
  const data = await createRes.json();
  memberId = data.user.id;
  memberToken = createTestToken(memberId, 'team');

  // Grant the member a mutating tool so the
  // write-path gating can be exercised.
  await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
    method: 'PUT',
    headers: h(superToken),
    body: JSON.stringify({ tools: ['knowledge_mutation'] }),
  });
});

afterAll(async () => {
  if (memberId) {
    await fetch(`${BASE_URL}/api/admin/users/${memberId}`, { method: 'DELETE', headers: h(superToken) }).catch(
      () => {},
    );
  }
});

// ─── Auth boundary ───────────────────────────────────────

describe('E2E: Agent proxy auth', () => {
  it('rejects the manifest without a token (401)', async () => {
    const res = await fetch(`${BASE_URL}/api/agent/runtime-manifest`);
    expect(res.status).toBe(401);
  });

  it('rejects an external user token (403)', async () => {
    const res = await fetch(`${BASE_URL}/api/agent/runtime-manifest`, { headers: h(externalToken) });
    expect(res.status).toBe(403);
  });

  it('rejects an old local-agent API key token (401)', async () => {
    const fakeKey = `lpai_sk_${'a'.repeat(64)}`;
    const res = await fetch(`${BASE_URL}/api/agent/runtime-manifest`, { headers: h(fakeKey) });
    expect(res.status).toBe(401);
  });
});

// ─── Manifest ────────────────────────────────────────────

describe('E2E: Agent runtime manifest', () => {
  it('returns the read-only server tools for the logged-in user', async () => {
    const res = await fetch(`${BASE_URL}/api/agent/runtime-manifest?profile_id=team`, {
      headers: h(memberToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.capabilities).toEqual({ serverTools: true, localTools: false });
    const ids = data.tools.map((t: { id: string }) => t.id);
    // Global read-only tools are present for any internal user.
    expect(ids).toContain('knowledge_query');
    // Non-allowlisted tools are never exposed (workbench_* is chat-only by design).
    expect(ids).not.toContain('workbench_query');
    // Each tool carries a JSON Schema for its input (agents need it to call).
    const sourceTool = data.tools.find((t: { id: string }) => t.id === 'knowledge_query');
    expect(sourceTool.inputSchema).toBeDefined();
  });
});

// ─── Tool calls ──────────────────────────────────────────

describe('E2E: Agent tool call', () => {
  it('executes an allowed read-only tool and returns structured output', async () => {
    const res = await fetch(`${BASE_URL}/api/agent/tools/knowledge_query/call`, {
      method: 'POST',
      headers: h(memberToken),
      body: JSON.stringify({ profile_id: 'team', input: { action: 'search', query: 'nutrient' } }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tool).toBe('knowledge_query');
    expect(data).toHaveProperty('output');
  });

  it('rejects a non-allowlisted tool (403)', async () => {
    const res = await fetch(`${BASE_URL}/api/agent/tools/workbench_query/call`, {
      method: 'POST',
      headers: h(memberToken),
      body: JSON.stringify({ profile_id: 'team', input: {} }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects invalid input for an allowed tool (400)', async () => {
    const res = await fetch(`${BASE_URL}/api/agent/tools/knowledge_query/call`, {
      method: 'POST',
      headers: h(memberToken),
      body: JSON.stringify({ profile_id: 'team', input: {} }), // missing required action/query
    });
    expect(res.status).toBe(400);
  });
});

// ─── Write tools (logged-in user + confirm) ──────────────

describe('E2E: Agent write-tool gating', () => {
  it('exposes a mutating proxy tool for a logged-in user who has that tool on the profile', async () => {
    const res = await fetch(`${BASE_URL}/api/agent/runtime-manifest?profile_id=team`, {
      headers: h(memberToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const entry = data.tools.find((t: { id: string }) => t.id === 'knowledge_mutation');
    expect(entry).toBeDefined();
    expect(entry.mutating).toBe(true);
  });

  it('still requires confirm:true to execute a mutating tool (400 without it)', async () => {
    const res = await fetch(`${BASE_URL}/api/agent/tools/knowledge_mutation/call`, {
      method: 'POST',
      headers: h(memberToken),
      body: JSON.stringify({
        profile_id: 'team',
        input: { action: 'knowledge.create_doc', title: 't', content: 'c' },
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(JSON.stringify(data)).toContain('confirm');
  });
});

// ─── Default profile (omitted profile_id) ────────────────
// A request without profile_id falls back to the internal `desktop` profile.

describe('E2E: Agent default profile', () => {
  it('manifest without profile_id resolves to the internal desktop profile', async () => {
    const res = await fetch(`${BASE_URL}/api/agent/runtime-manifest`, { headers: h(memberToken) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.profile_id).toBe('desktop');
    // The member's granted mutating tool is exposed under the internal default profile.
    const ids = data.tools.map((t: { id: string }) => t.id);
    expect(ids).toContain('knowledge_mutation');
  });

  it('a mutating tool call without profile_id reaches the tool (400 confirm), not 403', async () => {
    const res = await fetch(`${BASE_URL}/api/agent/tools/knowledge_mutation/call`, {
      method: 'POST',
      headers: h(memberToken),
      // No profile_id, no confirm: the tool must be reachable (→ 400 confirm), not 403.
      body: JSON.stringify({ input: { action: 'knowledge.create_doc', title: 't', content: 'c' } }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(JSON.stringify(data)).toContain('confirm');
  });
});
