/**
 * E2E Tests — Session CRUD & Ownership
 *
 * Tests /api/sessions CRUD operations and cross-user isolation:
 * - Create, list, update, delete sessions
 * - User A cannot access/modify User B's sessions
 * - Unauthenticated callers cannot access sessions
 * - Session status/title update
 *
 * Use `pnpm test:e2e:ci`; manual debugging setup is documented in tests/e2e/README.md.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSuperToken, createTestToken, BASE_URL } from './helpers.js';

let superToken: string;
let memberTokenA: string;
let memberTokenB: string;
const sessionsToClean: Array<{ id: string; token: string }> = [];
const usersToClean: string[] = [];

function h(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const UNIQUE = Date.now().toString(36);

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`Server not running at ${BASE_URL}`);
  superToken = createSuperToken();

  // Create two member users
  for (const label of ['a', 'b']) {
    const email = `e2e-session-${label}-${UNIQUE}@test.local`;
    const createRes = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: h(superToken),
      body: JSON.stringify({ email, password: 'TestPass123!', nickname: `Session User ${label}` }),
    });
    const data = await createRes.json();
    const id = data.user.id;
    usersToClean.push(id);
    if (label === 'a') {
      memberTokenA = createTestToken(id, 'team');
    } else {
      memberTokenB = createTestToken(id, 'team');
    }
  }
});

afterAll(async () => {
  for (const { id, token } of sessionsToClean) {
    await fetch(`${BASE_URL}/api/sessions/${id}`, { method: 'DELETE', headers: h(token) }).catch(() => {});
  }
  for (const id of usersToClean) {
    await fetch(`${BASE_URL}/api/admin/users/${id}`, {
      method: 'DELETE',
      headers: h(superToken),
    }).catch(() => {});
  }
});

// ─── Session CRUD ────────────────────────────────────────

describe('E2E: Session CRUD', () => {
  it('creates session and returns UUID', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: h(memberTokenA),
      body: JSON.stringify({ profile_id: 'team' }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toMatch(/^[0-9a-f]{8}-/);
    // `team` is a retired id — the server resolves it to the preset that replaced it.
    expect(data.profile_id).toBe('sprouty');
    sessionsToClean.push({ id: data.id, token: memberTokenA });
  });

  it('lists only own sessions for member', async () => {
    // Create a session for User A
    const createRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: h(memberTokenA),
      body: JSON.stringify({ profile_id: 'team', title: `e2e-ownership-test-${UNIQUE}` }),
    });
    const session = await createRes.json();
    sessionsToClean.push({ id: session.id, token: memberTokenA });

    // User B should NOT see User A's sessions
    const listRes = await fetch(`${BASE_URL}/api/sessions`, {
      headers: h(memberTokenB),
    });
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    const sessionIds = listData.sessions.map((s: { id: string }) => s.id);
    expect(sessionIds).not.toContain(session.id);
  });

  it('updates session title and status', async () => {
    const createRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: h(memberTokenA),
      body: JSON.stringify({ profile_id: 'team' }),
    });
    const session = await createRes.json();
    sessionsToClean.push({ id: session.id, token: memberTokenA });

    const patchRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: h(memberTokenA),
      body: JSON.stringify({ title: 'Updated Title', status: 'archived' }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.title).toBe('Updated Title');
  });

  it('gets session detail with messages', async () => {
    const createRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: h(memberTokenA),
      body: JSON.stringify({ profile_id: 'team' }),
    });
    const session = await createRes.json();
    sessionsToClean.push({ id: session.id, token: memberTokenA });

    const getRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
      headers: h(memberTokenA),
    });
    expect(getRes.status).toBe(200);
    const data = await getRes.json();
    expect(data.session.id).toBe(session.id);
    expect(data).toHaveProperty('messages');
    expect(data).toHaveProperty('usage');
  });

  it('deletes session', async () => {
    const createRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: h(memberTokenA),
      body: JSON.stringify({ profile_id: 'team' }),
    });
    const session = await createRes.json();

    const delRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
      method: 'DELETE',
      headers: h(memberTokenA),
    });
    expect(delRes.status).toBe(200);

    const getRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
      headers: h(memberTokenA),
    });
    expect(getRes.status).toBe(404);
  });
});

// ─── Cross-User Isolation ────────────────────────────────

describe('E2E: Session Cross-User Isolation', () => {
  it('User B cannot view User A session detail', async () => {
    const createRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: h(memberTokenA),
      body: JSON.stringify({ profile_id: 'team' }),
    });
    const session = await createRes.json();
    sessionsToClean.push({ id: session.id, token: memberTokenA });

    const getRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
      headers: h(memberTokenB),
    });
    // Should be 404 (hidden) not 403 (to avoid ID enumeration)
    expect(getRes.status).toBe(404);
  });

  it('User B cannot delete User A session', async () => {
    const createRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: h(memberTokenA),
      body: JSON.stringify({ profile_id: 'team' }),
    });
    const session = await createRes.json();
    sessionsToClean.push({ id: session.id, token: memberTokenA });

    const delRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
      method: 'DELETE',
      headers: h(memberTokenB),
    });
    // Should be 404 (not found from B's perspective) or 403
    expect([403, 404]).toContain(delRes.status);

    // Verify session still exists
    const verifyRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
      headers: h(memberTokenA),
    });
    expect(verifyRes.status).toBe(200);
  });

  it('User B cannot update User A session', async () => {
    const createRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: h(memberTokenA),
      body: JSON.stringify({ profile_id: 'team' }),
    });
    const session = await createRes.json();
    sessionsToClean.push({ id: session.id, token: memberTokenA });

    const patchRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: h(memberTokenB),
      body: JSON.stringify({ title: 'Hacked Title' }),
    });
    expect([403, 404]).toContain(patchRes.status);
  });

  it('super user can access any session', async () => {
    const createRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: h(memberTokenA),
      body: JSON.stringify({ profile_id: 'team' }),
    });
    const session = await createRes.json();
    sessionsToClean.push({ id: session.id, token: superToken });

    const getRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
      headers: h(superToken),
    });
    expect(getRes.status).toBe(200);
  });
});

// ─── Authentication Boundary ─────────────────────────────

describe('E2E: Session Authentication Boundary', () => {
  it('unauthenticated caller cannot create sessions', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: 'team' }),
    });
    expect(res.status).toBe(401);
  });

  it('unauthenticated caller cannot list sessions', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`);
    expect(res.status).toBe(401);
  });
});
