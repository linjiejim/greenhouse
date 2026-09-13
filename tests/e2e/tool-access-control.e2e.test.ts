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
    expect(toolIds).toContain('query_eval_runs');
    expect(toolIds).toContain('manage_eval_dataset');
    expect(toolIds).toContain('eval_message');

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
    expect(toolIds).not.toContain('query_eval_runs');
    expect(toolIds).not.toContain('eval_message');
  });
});

// ─── Tool Assignment Flow ────────────────────────────────

describe('E2E: Tool Assignment & Enforcement', () => {
  it('admin assigns tools → member can see them', async () => {
    // Assign two non-global tools to the member
    const assignRes = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: ['query_eval_runs', 'eval_message'] }),
    });
    expect(assignRes.status).toBe(200);

    // Now member should see global + assigned tools
    const toolsRes = await fetch(`${BASE_URL}/api/tools`, {
      headers: authHeaders(memberToken),
    });
    expect(toolsRes.status).toBe(200);
    const data = await toolsRes.json();
    const toolIds = data.tools.map((t: { id: string }) => t.id);

    // Global tools still present
    expect(toolIds).toContain('knowledge_query');
    expect(toolIds).toContain('analyze_image');
    expect(toolIds).toContain('ask_user');

    // Assigned tools now visible
    expect(toolIds).toContain('query_eval_runs');
    expect(toolIds).toContain('eval_message');

    // NOT assigned tools still hidden
    expect(toolIds).not.toContain('manage_eval_dataset');
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
    expect(toolIds).not.toContain('query_eval_runs');
    expect(toolIds).not.toContain('eval_message');
  });

  it('tool assignment rejects unknown tool IDs', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: ['query_eval_runs', 'nonexistent_tool'] }),
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
    const toolCalls = events.filter(
      (e: any) => e.type === 'tool-call' && ['query_eval_runs', 'manage_eval_dataset'].includes(e.toolName),
    );
    expect(toolCalls).toHaveLength(0);

    // Cleanup
    await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
      method: 'DELETE',
      headers: authHeaders(memberToken),
    });
  });
});

// ─── App tools follow their feature flag (Phase 2) ───────

describe('E2E: Missions tools follow the cloud-agent feature flag', () => {
  async function setMissions(enabled: boolean) {
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/features`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ feature: 'cloud-agent', enabled }),
    });
    expect(res.status).toBe(200);
  }

  async function memberToolIds(): Promise<string[]> {
    const res = await fetch(`${BASE_URL}/api/tools`, { headers: authHeaders(memberToken) });
    expect(res.status).toBe(200);
    const data = await res.json();
    return data.tools.map((t: { id: string }) => t.id);
  }

  it('member without the flag has no mission tool (not a separate assignment)', async () => {
    await setMissions(false);
    const toolIds = await memberToolIds();
    expect(toolIds).not.toContain('mission_dispatch');
  });

  it('enabling the flag grants the mission tool in chat', async () => {
    await setMissions(true);
    const toolIds = await memberToolIds();
    expect(toolIds).toContain('mission_dispatch');
  });

  it('disabling the flag removes the mission tool again', async () => {
    await setMissions(false);
    const toolIds = await memberToolIds();
    expect(toolIds).not.toContain('mission_dispatch');
  });

  it('flag-owned tools cannot be assigned directly (they ride the feature, not the bucket)', async () => {
    await setMissions(false);
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: ['mission_dispatch'] }),
    });
    expect(res.status).toBe(400);
    // And it stays absent — no assignment path around the flag.
    const toolIds = await memberToolIds();
    expect(toolIds).not.toContain('mission_dispatch');
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
    expect(knowledge.mainControl).toEqual({ type: 'capability', capability: 'knowledge.*' });

    // Baseline is read-only context: the always-on global tools. (The raw team-role
    // capability list was dropped 2026-08-14 — the app cards carry that information.)
    expect(data.baseline.globalTools.length).toBeGreaterThan(0);
    expect(data.baseline).not.toHaveProperty('roleCapabilities');

    // Tab placement is server-driven: every point declares its group.
    expect(new Set(data.featurePoints.map((p: { group: string }) => p.group))).toEqual(
      new Set(['basic', 'apps', 'advanced']),
    );
    // daily_message_limit retired 2026-08-07: column kept for storage compat,
    // but the access view exposes monthly_token_limit only.
    expect(data.limits).toHaveProperty('monthly_token_limit');
    expect(data.limits).not.toHaveProperty('daily_message_limit');
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
