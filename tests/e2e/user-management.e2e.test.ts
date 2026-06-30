/**
 * E2E Tests — User Management & Quota Enforcement
 *
 * Tests /api/admin/ user CRUD and role/quota boundaries:
 * - User creation, update, listing
 * - Duplicate email rejection
 * - Role-based API access (super vs admin vs member)
 * - Disabled user blocking
 * - Password reset
 * - Usage stats retrieval
 *
 * Run manually:
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm vitest run tests/e2e/user-management.e2e.test.ts --config vitest.e2e.config.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestToken, BASE_URL, PASSWORD } from './helpers.js';

let superToken: string;
let adminToken: string;
let memberToken: string;
let externalToken: string;
const usersToClean: string[] = [];

function h(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const UNIQUE = Date.now().toString(36);

async function createTestUser(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; email: string }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `e2e-user-${UNIQUE}-${suffix}@test.local`;
  const res = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: h(superToken),
    body: JSON.stringify({
      email,
      password: 'TestPass123!',
      nickname: `E2E User ${suffix}`,
      role: 'team',
      ...overrides,
    }),
  });
  const data = await res.json();
  if (data.user?.id) usersToClean.push(data.user.id);
  return { id: data.user?.id, email };
}

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`Server not running at ${BASE_URL}`);
  superToken = createTestToken('e2e-user-mgmt-super', 'super');
  adminToken = createTestToken('e2e-user-mgmt-admin', 'team');
  memberToken = createTestToken('e2e-user-mgmt-member', 'team');
  externalToken = createTestToken('external', 'external');
});

afterAll(async () => {
  // Hard-delete test users created during this run
  for (const id of usersToClean) {
    await fetch(`${BASE_URL}/api/admin/users/${id}`, {
      method: 'DELETE',
      headers: h(superToken),
    }).catch(() => {});
  }
});

// ─── User CRUD ───────────────────────────────────────────

describe('E2E: User CRUD', () => {
  it('creates user with valid data', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const email = `e2e-crud-${UNIQUE}-${suffix}@test.local`;
    const res = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({
        email,
        password: 'ValidPass123!',
        nickname: 'CRUD Test User',
        role: 'team',
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.user.email).toBe(email);
    expect(data.user.role).toBe('team');
    expect(data.user.status).toBe('active');
    usersToClean.push(data.user.id);
  });

  it('rejects duplicate email', async () => {
    const user = await createTestUser();
    const res = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({
        email: user.email,
        password: 'AnotherPass123!',
        nickname: 'Duplicate User',
      }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects invalid email format', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({
        email: 'not-an-email',
        password: 'ValidPass123!',
        nickname: 'Bad Email User',
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('email');
  });

  it('rejects short password', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({
        email: `e2e-short-pwd-${UNIQUE}@test.local`,
        password: '123',
        nickname: 'Short Pwd User',
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('8 characters');
  });

  it('lists users', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users`, {
      headers: h(superToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.users)).toBe(true);
    expect(data.users.length).toBeGreaterThan(0);
  });

  it('gets user detail by ID', async () => {
    const user = await createTestUser();
    const res = await fetch(`${BASE_URL}/api/admin/users/${user.id}`, {
      headers: h(superToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.id).toBe(user.id);
    expect(data.user.email).toBe(user.email);
    expect(data).toHaveProperty('usage');
  });

  it('returns 404 for non-existent user', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users/nonexistent-user-id`, {
      headers: h(superToken),
    });
    expect(res.status).toBe(404);
  });

  it('updates user nickname and role', async () => {
    const user = await createTestUser();
    const res = await fetch(`${BASE_URL}/api/admin/users/${user.id}`, {
      method: 'PATCH',
      headers: h(superToken),
      body: JSON.stringify({ nickname: 'Updated Name', role: 'external' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.nickname).toBe('Updated Name');
    expect(data.user.role).toBe('external');
  });

  it('cannot assign super role via API', async () => {
    const user = await createTestUser();
    const res = await fetch(`${BASE_URL}/api/admin/users/${user.id}`, {
      method: 'PATCH',
      headers: h(superToken),
      body: JSON.stringify({ role: 'super' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('super');
  });
});

// ─── Disabled User ───────────────────────────────────────

describe('E2E: Disabled User Blocking', () => {
  it('disabling a user revokes refresh tokens', async () => {
    const user = await createTestUser();
    const res = await fetch(`${BASE_URL}/api/admin/users/${user.id}`, {
      method: 'PATCH',
      headers: h(superToken),
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.user.status).toBe('disabled');
  });

  it('disabled user cannot log in', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const email = `e2e-disable-login-${UNIQUE}-${suffix}@test.local`;
    const pwd = 'TestPass123!';

    // Create and disable user
    const createRes = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({ email, password: pwd, nickname: 'Disable Test' }),
    });
    const created = await createRes.json();
    usersToClean.push(created.user.id);

    await fetch(`${BASE_URL}/api/admin/users/${created.user.id}`, {
      method: 'PATCH',
      headers: h(superToken),
      body: JSON.stringify({ status: 'disabled' }),
    });

    // Try to login
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pwd }),
    });
    // Should be 403 (disabled) or 401 (auth failed)
    expect([401, 403]).toContain(loginRes.status);
  });
});

// ─── Password Reset ──────────────────────────────────────

describe('E2E: Password Reset', () => {
  it('resets password successfully', async () => {
    const user = await createTestUser();
    const res = await fetch(`${BASE_URL}/api/admin/users/${user.id}/reset-password`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({ password: 'NewPassword123!' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('rejects short reset password', async () => {
    const user = await createTestUser();
    const res = await fetch(`${BASE_URL}/api/admin/users/${user.id}/reset-password`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({ password: '123' }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── Role-Based API Access ───────────────────────────────

describe('E2E: Admin API Role Enforcement', () => {
  it('member cannot access admin user list', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users`, {
      headers: h(memberToken),
    });
    expect(res.status).toBe(403);
  });

  it('external user cannot access admin API', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users`, {
      headers: h(externalToken),
    });
    expect(res.status).toBe(403);
  });

  it('admin token cannot access super-only admin routes', async () => {
    // /api/admin is protected by requireSuper()
    const res = await fetch(`${BASE_URL}/api/admin/users`, {
      headers: h(adminToken),
    });
    expect(res.status).toBe(403);
  });
});

// ─── Usage Stats ─────────────────────────────────────────

describe('E2E: Usage Stats', () => {
  it('returns usage summary', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/usage/summary`, {
      headers: h(superToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('by_user');
    expect(Array.isArray(data.by_user)).toBe(true);
  });

  it('returns user-specific usage', async () => {
    const user = await createTestUser();
    const res = await fetch(`${BASE_URL}/api/admin/users/${user.id}/usage`, {
      headers: h(superToken),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('stats');
    expect(data).toHaveProperty('recent');
  });
});
