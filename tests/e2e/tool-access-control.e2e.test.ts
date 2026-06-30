/**
 * E2E Security Tests — Tool Access Control
 *
 * Validates that users can only access tools within their permission scope:
 * - External users: global tools only
 * - Members: global + admin-assigned tools
 * - Super: all tools
 *
 * Run manually:
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm vitest run tests/e2e/ --config vitest.e2e.config.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestToken, BASE_URL, PASSWORD, authHeaders } from './helpers.js';

// ─── Token generation (we know the ACCESS_PASSWORD) ──────

// ─── Test User State ─────────────────────────────────────

let superToken: string;
let memberToken: string;
let externalToken: string;
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
    throw new Error(
      `Server not running at ${BASE_URL}. Start with: API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm api`,
    );
  }

  superToken = createTestToken('e2e-super', 'super');
  externalToken = createTestToken('external', 'external');
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

    // Super should see ALL tools (public + team-global + non-global team tools)
    expect(toolIds).toContain('knowledge_query');
    expect(toolIds).toContain('analyze_image');
    expect(toolIds).toContain('ask_user');
    expect(toolIds).toContain('external_search');
    expect(toolIds).toContain('knowledge_mutation');
    expect(toolIds).toContain('email_query'); // non-global, but super sees all
  });

  it('external user sees only public tools', async () => {
    const res = await fetch(`${BASE_URL}/api/tools`, {
      headers: authHeaders(externalToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const toolIds = data.tools.map((t: { id: string }) => t.id);

    // External (public) users see only the public-category global tools.
    expect(toolIds).toContain('analyze_image');
    expect(toolIds).toContain('ask_user');

    // Should NOT see any team-scoped tools.
    expect(toolIds).not.toContain('knowledge_query');
    expect(toolIds).not.toContain('external_search');
    expect(toolIds).not.toContain('knowledge_mutation');
    expect(toolIds).not.toContain('feature_request');
    expect(toolIds).not.toContain('generate_image');
    expect(toolIds).not.toContain('project_manager');
  });

  it('team user without assignments sees global tools but not non-global ones', async () => {
    // A team user sees every is_global tool, plus any tools assigned to them.
    const res = await fetch(`${BASE_URL}/api/tools`, {
      headers: authHeaders(memberToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    const toolIds = data.tools.map((t: { id: string }) => t.id);

    // Global team tools are visible without assignment.
    expect(toolIds).toContain('knowledge_query');
    expect(toolIds).toContain('knowledge_mutation');
    expect(toolIds).toContain('external_search');
    expect(toolIds).toContain('analyze_image');
    expect(toolIds).toContain('ask_user');

    // Non-global tools require an explicit assignment.
    expect(toolIds).not.toContain('email_query');
    expect(toolIds).not.toContain('email_mutation');
  });
});

// ─── Tool Assignment Flow ────────────────────────────────

describe('E2E: Tool Assignment & Enforcement', () => {
  it('admin assigns a non-global tool → member can see it', async () => {
    // email_query is a non-global team tool, so it only appears once assigned.
    const assignRes = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: ['email_query'] }),
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

    // The assigned non-global tool is now visible
    expect(toolIds).toContain('email_query');

    // Other non-global tools that were NOT assigned stay hidden
    expect(toolIds).not.toContain('email_mutation');
  });

  it('removing tools takes effect immediately', async () => {
    // Clear all tool assignments
    const assignRes = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: [] }),
    });
    expect(assignRes.status).toBe(200);

    // Member should be back to global-only (the assigned non-global tool is gone)
    const toolsRes = await fetch(`${BASE_URL}/api/tools`, {
      headers: authHeaders(memberToken),
    });
    const data = await toolsRes.json();
    const toolIds = data.tools.map((t: { id: string }) => t.id);

    expect(toolIds).toContain('knowledge_query');
    expect(toolIds).not.toContain('email_query');
  });

  it('tool assignment rejects unknown tool IDs', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      method: 'PUT',
      headers: authHeaders(superToken),
      body: JSON.stringify({ tools: ['external_search', 'nonexistent_tool'] }),
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
      body: JSON.stringify({ profile_id: 'default' }),
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

    // If any tool calls happened, they should NOT be knowledge_mutation
    const toolCalls = events.filter(
      (e: any) => e.type === 'tool-call' && ['knowledge_mutation'].includes(e.toolName),
    );
    expect(toolCalls).toHaveLength(0);

    // Cleanup
    await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
      method: 'DELETE',
      headers: authHeaders(memberToken),
    });
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

  it('external user cannot access admin tool assignment API', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/tools`, {
      headers: authHeaders(externalToken),
    });
    expect(res.status).toBe(403);
  });
});
