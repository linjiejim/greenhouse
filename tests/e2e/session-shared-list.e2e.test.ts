/**
 * E2E Tests — Shared sessions in the list endpoint
 *
 * Verifies that GET /api/sessions flags sessions correctly so the web "Shared
 * with me" filter works:
 *   - is_owner: true on sessions you created, false on ones shared to you
 *   - shared:   true ONLY on sessions someone else shared with you
 *               (your own session — even shared to __team__ — is NOT "shared with me")
 *
 * Run manually:
 *   # Terminal 1
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm api
 *   # Terminal 2
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm test:e2e tests/e2e/session-shared-list.e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestToken, BASE_URL } from './helpers.js';

let superToken: string;
let tokenA: string;
let tokenB: string;
let idA: string;
let idB: string;
const sessionsToClean: string[] = [];
const usersToClean: string[] = [];

function h(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const UNIQUE = Date.now().toString(36);

async function createUser(label: string): Promise<string> {
  const email = `e2e-shared-${label}-${UNIQUE}@test.local`;
  const res = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: h(superToken),
    body: JSON.stringify({ email, password: 'TestPass123!', nickname: `Shared User ${label}` }),
  });
  const data = await res.json();
  const id = data.user.id;
  usersToClean.push(id);
  return id;
}

async function createSession(token: string, title: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: h(token),
    body: JSON.stringify({ profile_id: 'default', title }),
  });
  const data = await res.json();
  sessionsToClean.push(data.id);
  return data.id;
}

async function listSessions(token: string): Promise<any[]> {
  const res = await fetch(`${BASE_URL}/api/sessions`, { headers: h(token) });
  expect(res.status).toBe(200);
  const data = await res.json();
  return data.sessions as any[];
}

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`Server not running at ${BASE_URL}`);
  superToken = createTestToken('e2e-shared-super', 'super');
  idA = await createUser('a');
  idB = await createUser('b');
  // 'team' is this system's internal role (super | team | external);
  // /api/shares/* is gated by requireInternal() which only accepts super|team.
  tokenA = createTestToken(idA, 'team');
  tokenB = createTestToken(idB, 'team');
});

afterAll(async () => {
  for (const id of sessionsToClean) {
    await fetch(`${BASE_URL}/api/sessions/${id}`, { method: 'DELETE', headers: h(superToken) }).catch(() => {});
  }
  for (const id of usersToClean) {
    await fetch(`${BASE_URL}/api/admin/users/${id}`, { method: 'DELETE', headers: h(superToken) }).catch(() => {});
  }
});

describe('E2E: Shared sessions appear & are flagged in the list', () => {
  it('direct share: recipient sees the session with shared=true, is_owner=false', async () => {
    const sessionId = await createSession(tokenA, `e2e-direct-${UNIQUE}`);

    // A shares with B
    const shareRes = await fetch(`${BASE_URL}/api/shares`, {
      method: 'POST',
      headers: h(tokenA),
      body: JSON.stringify({ session_id: sessionId, user_ids: [idB] }),
    });
    expect(shareRes.status).toBe(200);

    // B's list: session present, flagged shared
    const listB = await listSessions(tokenB);
    const inB = listB.find((s) => s.id === sessionId);
    expect(inB, 'shared session should appear in recipient list').toBeTruthy();
    expect(inB.is_owner).toBe(false);
    expect(inB.shared).toBe(true);
  });

  it("owner's own list: the same session is is_owner=true, shared=false", async () => {
    // Reuse the session from the previous test by re-sharing a fresh one for isolation
    const sessionId = await createSession(tokenA, `e2e-owner-${UNIQUE}`);
    await fetch(`${BASE_URL}/api/shares`, {
      method: 'POST',
      headers: h(tokenA),
      body: JSON.stringify({ session_id: sessionId, user_ids: [idB] }),
    });

    const listA = await listSessions(tokenA);
    const inA = listA.find((s) => s.id === sessionId);
    expect(inA).toBeTruthy();
    expect(inA.is_owner).toBe(true);
    // Owner shared it OUT — that does not make it "shared with me"
    expect(inA.shared).toBe(false);
  });

  it('team share: recipient sees shared=true; owner stays shared=false', async () => {
    const sessionId = await createSession(tokenA, `e2e-team-${UNIQUE}`);
    const shareRes = await fetch(`${BASE_URL}/api/shares`, {
      method: 'POST',
      headers: h(tokenA),
      body: JSON.stringify({ session_id: sessionId, team: true }),
    });
    expect(shareRes.status).toBe(200);

    const listB = await listSessions(tokenB);
    const inB = listB.find((s) => s.id === sessionId);
    expect(inB, 'team-shared session should appear for other team member').toBeTruthy();
    expect(inB.is_owner).toBe(false);
    expect(inB.shared).toBe(true);

    const listA = await listSessions(tokenA);
    const inA = listA.find((s) => s.id === sessionId);
    expect(inA.is_owner).toBe(true);
    expect(inA.shared).toBe(false);
  });

  it('un-shared session is NOT flagged for other users', async () => {
    const sessionId = await createSession(tokenA, `e2e-private-${UNIQUE}`);
    // Never shared → B should not see it at all
    const listB = await listSessions(tokenB);
    expect(listB.find((s) => s.id === sessionId)).toBeFalsy();

    // A sees it, unflagged
    const listA = await listSessions(tokenA);
    const inA = listA.find((s) => s.id === sessionId);
    expect(inA.is_owner).toBe(true);
    expect(inA.shared).toBe(false);
  });
});
