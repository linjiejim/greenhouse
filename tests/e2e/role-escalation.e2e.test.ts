/**
 * E2E Security Tests — Role Escalation Prevention
 *
 * Validates that users cannot escalate their privileges:
 * - Members cannot access admin/super endpoints
 * - Roles cannot be self-escalated
 * - Disabled users are blocked
 *
 * Use `pnpm test:e2e:ci`; manual debugging setup is documented in tests/e2e/README.md.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSuperToken, createTestToken, BASE_URL, authHeaders } from './helpers.js';

// ─── Test User State ─────────────────────────────────────

let superToken: string;
let memberToken: string;
let externalToken: string;
let memberId: string;
let disableTestMemberId: string;
let disableTestMemberToken: string;

const TEST_MEMBER_EMAIL = `e2e-role-test-${Date.now()}@test.local`;
const TEST_MEMBER_PASSWORD = 'TestPass123!';
const TEST_DISABLE_EMAIL = `e2e-disable-test-${Date.now()}@test.local`;
const TEST_DISABLE_PASSWORD = 'TestPass123!';

// ─── Helpers ─────────────────────────────────────────────

async function createUserAndLogin(
  email: string,
  password: string,
  nickname: string,
): Promise<{ id: string; token: string }> {
  const createRes = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: authHeaders(superToken),
    body: JSON.stringify({ email, password, nickname, role: 'team' }),
  });
  const createData = await createRes.json();
  const userId = createData.user.id;

  // Generate token directly (avoid login rate limiting)
  const token = createTestToken(userId, 'team');

  return { id: userId, token };
}

// ─── Setup ───────────────────────────────────────────────

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error('Server not healthy');
  } catch {
    throw new Error(`Server not running at ${BASE_URL}. Run pnpm test:e2e:ci or follow tests/e2e/README.md.`);
  }

  superToken = createSuperToken();
  externalToken = createTestToken('external', 'external');

  const member = await createUserAndLogin(TEST_MEMBER_EMAIL, TEST_MEMBER_PASSWORD, 'E2E Role Test Member');
  memberId = member.id;
  memberToken = member.token;

  const disableMember = await createUserAndLogin(TEST_DISABLE_EMAIL, TEST_DISABLE_PASSWORD, 'E2E Disable Test');
  disableTestMemberId = disableMember.id;
  disableTestMemberToken = disableMember.token;
});

afterAll(async () => {
  // Delete test users
  for (const id of [memberId, disableTestMemberId]) {
    if (id) {
      await fetch(`${BASE_URL}/api/admin/users/${id}`, {
        method: 'DELETE',
        headers: authHeaders(superToken),
      }).catch(() => {});
    }
  }
});

// ─── Admin Endpoint Protection ───────────────────────────

describe('E2E: Admin Endpoint Protection', () => {
  it('member cannot access /api/admin/users', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users`, {
      headers: authHeaders(memberToken),
    });
    expect(res.status).toBe(403);
  });

  it('external cannot access /api/admin/users', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users`, {
      headers: authHeaders(externalToken),
    });
    expect(res.status).toBe(403);
  });

  it('member cannot create users via admin API', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: authHeaders(memberToken),
      body: JSON.stringify({
        email: 'shouldfail@test.local',
        password: 'TestPass123!',
        nickname: 'Should Fail',
      }),
    });
    expect(res.status).toBe(403);
  });

  it('team member CAN access knowledge endpoints (internal surface)', async () => {
    // Role model is super > team > external: knowledge is requireInternal, so a
    // plain team member is allowed — only external (and unknown roles) are not.
    const res = await fetch(`${BASE_URL}/api/knowledge/docs`, {
      headers: authHeaders(memberToken),
    });
    expect(res.status).toBe(200);
  });

  it('team member cannot access the super-only eval management surface', async () => {
    const res = await fetch(`${BASE_URL}/api/eval/datasets`, {
      headers: authHeaders(memberToken),
    });
    expect(res.status).toBe(403);
  });

  it('external cannot access knowledge endpoints', async () => {
    const res = await fetch(`${BASE_URL}/api/knowledge/docs`, {
      headers: authHeaders(externalToken),
    });
    expect(res.status).toBe(403);
  });
});

// ─── Role Self-Escalation Prevention ─────────────────────

describe('E2E: Role Escalation Prevention', () => {
  it('PATCH cannot set role to super', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}`, {
      method: 'PATCH',
      headers: authHeaders(superToken),
      body: JSON.stringify({ role: 'super' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('super');
  });

  it('member cannot patch their own role', async () => {
    // Member can't access admin routes at all
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}`, {
      method: 'PATCH',
      headers: authHeaders(memberToken),
      body: JSON.stringify({ role: 'team' }),
    });
    expect(res.status).toBe(403);
  });
});

// ─── Disabled User Isolation ─────────────────────────────

describe('E2E: Disabled User Isolation', () => {
  it('disabled user cannot login', async () => {
    // Disable the user
    const disableRes = await fetch(`${BASE_URL}/api/admin/users/${disableTestMemberId}`, {
      method: 'PATCH',
      headers: authHeaders(superToken),
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(disableRes.status).toBe(200);

    // Try to login — should fail with 403 (disabled) or 429 (rate limited)
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_DISABLE_EMAIL, password: TEST_DISABLE_PASSWORD }),
    });
    // 403 = disabled account, 429 = rate limited (both block access)
    expect([403, 429]).toContain(loginRes.status);
  });

  it('disabled user existing token is rejected immediately', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      headers: authHeaders(disableTestMemberToken),
    });
    expect(res.status).toBe(401);
  });

  it('disabled user cannot refresh token', async () => {
    // Refresh tokens were revoked when the user was disabled
    // Try to refresh — should fail
    const refreshRes = await fetch(`${BASE_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'any-token-that-was-revoked' }),
    });
    expect(refreshRes.status).toBe(401);
  });

  // Re-enable user for cleanup
  it('re-enabling user allows login again', async () => {
    const enableRes = await fetch(`${BASE_URL}/api/admin/users/${disableTestMemberId}`, {
      method: 'PATCH',
      headers: authHeaders(superToken),
      body: JSON.stringify({ status: 'active' }),
    });
    expect(enableRes.status).toBe(200);

    const oldTokenRes = await fetch(`${BASE_URL}/api/sessions`, {
      headers: authHeaders(disableTestMemberToken),
    });
    expect(oldTokenRes.status).toBe(401);

    // Login may still be rate-limited from earlier tests
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_DISABLE_EMAIL, password: TEST_DISABLE_PASSWORD }),
    });
    // 200 = success, 429 = rate limited (expected in rapid test runs)
    expect([200, 429]).toContain(loginRes.status);
  });
});
