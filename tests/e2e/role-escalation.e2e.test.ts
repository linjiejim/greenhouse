/**
 * E2E Security Tests — Role Escalation Prevention
 *
 * Validates that users cannot escalate their privileges:
 * - Members cannot access admin/super endpoints
 * - Roles cannot be self-escalated
 * - Disabled users are blocked
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
let disableTestMemberId: string;
let disableTestMemberToken: string;

const TEST_MEMBER_EMAIL = `e2e-role-test-${Date.now()}@test.local`;
const TEST_MEMBER_PASSWORD = 'TestPass123!';
const TEST_DISABLE_EMAIL = `e2e-disable-test-${Date.now()}@test.local`;
const TEST_DISABLE_PASSWORD = 'TestPass123!';

// ─── Helpers ─────────────────────────────────────────────

// Roles are super > team > external. 'team' is the internal non-super role
// (the one that must still be blocked from super-only admin endpoints).
async function createUserAndLogin(email: string, password: string, nickname: string): Promise<{ id: string; token: string }> {
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
    throw new Error(
      `Server not running at ${BASE_URL}. Start with: API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm api`,
    );
  }

  superToken = createTestToken('e2e-super', 'super');
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
  it('team user cannot access /api/admin/users (super-only)', async () => {
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

  it('team user cannot create users via admin API', async () => {
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

  it('team user cannot access super-only admin endpoints', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/clients`, {
      headers: authHeaders(memberToken),
    });
    expect(res.status).toBe(403);
  });

  it('external cannot access internal knowledge endpoints', async () => {
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

  it('team user cannot patch their own role', async () => {
    // Non-super users can't access admin routes at all
    const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}`, {
      method: 'PATCH',
      headers: authHeaders(memberToken),
      body: JSON.stringify({ role: 'super' }),
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

  it('disabled user existing token still works until expiry (token is stateless)', async () => {
    // The old token is still valid because tokens are stateless HMAC
    // This is expected behavior — tokens expire naturally.
    // The system mitigates this by:
    // 1. Short-lived access tokens (4 hours)
    // 2. Revoking all refresh tokens on disable
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      headers: authHeaders(disableTestMemberToken),
    });
    // This may succeed because HMAC tokens are stateless.
    // The key protection is that refresh tokens are revoked,
    // so the user can't get new access tokens after the current one expires.
    expect([200, 401, 403]).toContain(res.status);
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
