/**
 * E2E Security Tests — Tool Access Control
 *
 * Validates that users can only access tools within their permission scope:
 * - Unauthenticated callers: rejected
 * - Team users: global + admin-assigned tools
 * - Super: all tools
 *
 * Use `pnpm test:e2e:ci`; manual debugging setup is documented in tests/e2e/README.md.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSuperToken, createTestToken, BASE_URL, authHeaders } from './helpers.js';

// ─── Test User State ─────────────────────────────────────

let superToken: string;
let memberToken: string;
let memberId: string;

const TEST_MEMBER_EMAIL = `e2e-tool-test-${Date.now()}@test.local`;
const TEST_MEMBER_PASSWORD = 'TestPass123!';

// ─── Helpers ─────────────────────────────────────────────

async function createMember(): Promise<{ id: string; token: string }> {
  // Create member via admin API
  const createRes = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: authHeaders(superToken),
    body: JSON.stringify({
      email: TEST_MEMBER_EMAIL,
      password: TEST_MEMBER_PASSWORD,
      nickname: 'E2E Tool Test Member',
      role: 'team',
    }),
  });
  const createData = await createRes.json();
  const userId = createData.user.id;

  // Generate token directly (avoid login rate limiting)
  const token = createTestToken(userId, 'team');

  return { id: userId, token };
}

// ─── Setup / Teardown ────────────────────────────────────

beforeAll(async () => {
  // Verify server is running
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error('Server not healthy');
  } catch {
    throw new Error(`Server not running at ${BASE_URL}. Run pnpm test:e2e:ci or follow tests/e2e/README.md.`);
  }

  superToken = createSuperToken();
  const member = await createMember();
  memberId = member.id;
  memberToken = member.token;
});

afterAll(async () => {
  // Delete test user
  if (memberId) {
    await fetch(`${BASE_URL}/api/admin/users/${memberId}`, {
      method: 'DELETE',
      headers: authHeaders(superToken),
    }).catch(() => {});
  }
});

// ─── GET /api/tools — Tool Visibility ─────────────────────

describe('E2E: Tool Visibility by Role', () => {
  it('super user sees all tools', async () => {
    const res = await fetch(`${BASE_URL}/api/tools`, {
      headers: authHeaders(superToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const toolIds = data.tools.map((t: { id: string }) => t.id);
    const toolsById = new Map<string, { surface?: { proxy?: 'read' | 'write' | 'none'; mcp?: boolean } }>(
      data.tools.map((tool: { id: string }) => [tool.id, tool]),
    );

    // Super should see ALL tools (public + team + admin)
    expect(toolIds).toContain('knowledge_query');
    expect(toolIds).toContain('analyze_image');
    expect(toolIds).toContain('ask_user');
    expect(toolIds).toContain('external_search');
    expect(toolIds).toContain('knowledge_mutation');
    // Extension tools ride their feature point; scripts/e2e-ci.sh boots the example one.
    expect(toolIds).toContain('example_notes_query');

    // Risk labels in the Agent editor consume the registry's authoritative
    // surface declaration. Undefined remains undefined rather than guessing.
    expect(toolsById.get('knowledge_query')?.surface?.proxy).toBe('read');
    expect(toolsById.get('knowledge_mutation')?.surface?.proxy).toBe('write');
    expect(toolsById.get('ask_user')?.surface).toBeUndefined();
  });

  it('unauthenticated caller cannot enumerate tools', async () => {
    const res = await fetch(`${BASE_URL}/api/tools`);
    expect(res.status).toBe(401);
  });

  it('member without assignments sees only global tools', async () => {
    // Member starts with no tool assignments → only global tools
    const res = await fetch(`${BASE_URL}/api/tools`, {
      headers: authHeaders(memberToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const toolIds = data.tools.map((t: { id: string }) => t.id);

    // Should see global tools
    expect(toolIds).toContain('knowledge_query');
    expect(toolIds).toContain('analyze_image');
    expect(toolIds).toContain('ask_user');

    // Should NOT see non-global (assignment-only) tools
    expect(toolIds).not.toContain('example_notes_query');
  });
});

// ─── Tool Assignment Flow ────────────────────────────────

describe('E2E: Tool Assignment & Enforcement', () => {
  it('admin replaces the assignment set → stored and reflected for the member', async () => {
    // v1.4 core ships no individually assignable tool: every non-global tool rides a
    // feature point. The bucket stays for extensions, so the round trip is exercised
    // with the empty set and a feature-owned tool is refused.
    const assignRes = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: [] }),
    });
    expect(assignRes.status).toBe(200);

    const storedRes = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      headers: authHeaders(superToken),
    });
    expect(storedRes.status).toBe(200);
    expect((await storedRes.json()).assigned).toEqual([]);

    const featureOwnedRes = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: ['example_notes_query'] }),
    });
    expect(featureOwnedRes.status).toBe(400);
    expect((await featureOwnedRes.json()).error).toContain('example_notes_query');

    const toolsRes = await fetch(`${BASE_URL}/api/tools`, {
      headers: authHeaders(memberToken),
    });
    expect(toolsRes.status).toBe(200);
    const data = await toolsRes.json();
    const toolIds = data.tools.map((t: { id: string }) => t.id);

    // Global tools still present; the refused tool never leaks in
    expect(toolIds).toContain('knowledge_query');
    expect(toolIds).toContain('analyze_image');
    expect(toolIds).toContain('ask_user');
    expect(toolIds).not.toContain('example_notes_query');
  });

  it('removing tools takes effect immediately', async () => {
    // Clear all tool assignments
    const assignRes = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: [] }),
    });
    expect(assignRes.status).toBe(200);

    // Member should be back to global-only
    const toolsRes = await fetch(`${BASE_URL}/api/tools`, {
      headers: authHeaders(memberToken),
    });
    const data = await toolsRes.json();
    const toolIds = data.tools.map((t: { id: string }) => t.id);

    expect(toolIds).toContain('knowledge_query');
    expect(toolIds).not.toContain('example_notes_query');
  });

  it('tool assignment rejects unknown tool IDs', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: ['example_notes_query', 'nonexistent_tool'] }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('nonexistent_tool');
  });

  it('member without admin tool assignment cannot use admin tools', async () => {
    // Ensure member has no admin tool assignments
    await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: [] }),
    });

    // Create a session for the member
    const sessionRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(memberToken),
      body: JSON.stringify({ profile_id: 'team' }),
    });
    expect(sessionRes.status).toBe(201);
    const session = await sessionRes.json();

    // Send chat — backend resolves tools from user's allowed set (no client-side override)
    const chatRes = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: authHeaders(memberToken),
      body: JSON.stringify({
        session_id: session.id,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    // 200 = success (only allowed tools loaded), 429 = rate limited in test suite
    expect([200, 429]).toContain(chatRes.status);

    // Read the NDJSON stream
    const text = await chatRes.text();
    const events = text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // If any tool calls happened, they should NOT be unassigned tools
    const toolCalls = events.filter((e: any) => e.type === 'tool-call' && e.toolName === 'example_notes_query');
    expect(toolCalls).toHaveLength(0);

    // Cleanup
    await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
      method: 'DELETE',
      headers: authHeaders(memberToken),
    });
  });
});

// ─── App tools follow their feature flag (Phase 2) ───────

describe('E2E: Tables tools follow the tables feature flag', () => {
  async function setTables(enabled: boolean) {
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/features`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ feature: 'tables', enabled }),
    });
    expect(res.status).toBe(200);
  }

  async function memberToolIds(): Promise<string[]> {
    const res = await fetch(`${BASE_URL}/api/tools`, { headers: authHeaders(memberToken) });
    expect(res.status).toBe(200);
    const data = await res.json();
    return data.tools.map((t: { id: string }) => t.id);
  }

  afterAll(async () => {
    await setTables(true);
  });

  it('member without the flag has no tables tool (not a separate assignment)', async () => {
    await setTables(false);
    const toolIds = await memberToolIds();
    expect(toolIds).not.toContain('tables_query');
  });

  it('enabling the flag grants the tables tools in chat', async () => {
    await setTables(true);
    const toolIds = await memberToolIds();
    expect(toolIds).toContain('tables_query');
  });

  it('disabling the flag removes the tables tools again', async () => {
    await setTables(false);
    const toolIds = await memberToolIds();
    expect(toolIds).not.toContain('tables_query');
  });

  it('flag-owned tools cannot be assigned directly (they ride the feature, not the bucket)', async () => {
    await setTables(false);
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: ['tables_query'] }),
    });
    expect(res.status).toBe(400);
    // And it stays absent — no assignment path around the flag.
    const toolIds = await memberToolIds();
    expect(toolIds).not.toContain('tables_query');
  });
});

// ─── Unified access view (feature-point aggregate) ───────

describe('E2E: Unified access view', () => {
  it('GET /api/admin/users/:id/access returns feature points and baseline', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/access`, {
      headers: authHeaders(superToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    const keys = data.featurePoints.map((p: { key: string }) => p.key);
    expect(keys).toContain('tables');
    expect(keys).toContain('knowledge');
    expect(keys).toContain('tools');

    const tables = data.featurePoints.find((p: { key: string }) => p.key === 'tables');
    expect(tables.mainControl).toEqual({ type: 'flag', flag: 'tables' });
    expect(Array.isArray(tables.capabilities)).toBe(true);

    const knowledge = data.featurePoints.find((p: { key: string }) => p.key === 'knowledge');
    // Per-user capability overrides were retired in 3.0: app access follows the role.
    expect(knowledge.mainControl).toBeNull();

    // Baseline is read-only context: the always-on global tools. (The raw team-role
    // capability list was dropped 2026-08-14 — the app cards carry that information.)
    expect(data.baseline.globalTools.length).toBeGreaterThan(0);
    expect(data.baseline).not.toHaveProperty('roleCapabilities');

    // Tab placement is server-driven: every point declares its group.
    expect(new Set(data.featurePoints.map((p: { group: string }) => p.group))).toEqual(
      new Set(['basic', 'apps', 'advanced']),
    );
    // The per-member quotas are gone in 3.0 (member spend is a USD budget).
    expect(data).not.toHaveProperty('limits');
  });

  it('member cannot access the aggregate view', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/access`, {
      headers: authHeaders(memberToken),
    });
    expect(res.status).toBe(403);
  });
});

// ─── Admin Tool Assignment API ───────────────────────────

describe('E2E: Admin Tool Assignment API', () => {
  it('GET /api/admin/users/:id/tools shows assigned and available', async () => {
    // First assign some tools
    await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: ['external_search'] }),
    });

    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      headers: authHeaders(superToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.assigned).toContain('external_search');
    expect(data.available.length).toBeGreaterThanOrEqual(10); // all known tools

    // Cleanup
    await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: [] }),
    });
  });

  it('member cannot access admin tool assignment API', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      headers: authHeaders(memberToken),
    });
    expect(res.status).toBe(403);
  });

  it('unauthenticated caller cannot access admin tool assignment API', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`);
    expect(res.status).toBe(401);
  });
});
