/**
 * E2E Security Tests — Profile Access Control.
 *
 * Run manually:
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm vitest run tests/e2e/ --config vitest.e2e.config.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestToken, BASE_URL, authHeaders } from './helpers.js';

let superToken: string;
let memberToken: string;
let externalToken: string;
let memberId: string;
const sessionsToClean: Array<{ id: string; token: string }> = [];

const TEST_MEMBER_EMAIL = `e2e-profile-test-${Date.now()}@test.local`;
const TEST_MEMBER_PASSWORD = 'TestPass123!';

async function createMember(): Promise<{ id: string; token: string }> {
  const createRes = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: authHeaders(superToken),
    body: JSON.stringify({
      email: TEST_MEMBER_EMAIL,
      password: TEST_MEMBER_PASSWORD,
      nickname: 'E2E Profile Test Member',
      role: 'team',
    }),
  });
  const createData = await createRes.json();
  return { id: createData.user.id, token: createTestToken(createData.user.id, 'team') };
}

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/health`).catch(() => null);
  if (!res?.ok) {
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
  for (const { id, token } of sessionsToClean) {
    await fetch(`${BASE_URL}/api/sessions/${id}`, { method: 'DELETE', headers: authHeaders(token) }).catch(() => {});
  }
  if (memberId) {
    await fetch(`${BASE_URL}/api/admin/users/${memberId}`, {
      method: 'DELETE',
      headers: authHeaders(superToken),
    }).catch(() => {});
  }
});

describe('E2E: Profile List Filtering by Role', () => {
  it('external user only sees default', async () => {
    const res = await fetch(`${BASE_URL}/api/profiles`, { headers: authHeaders(externalToken) });
    expect(res.status).toBe(200);
    const data = await res.json();
    const profileIds = data.profiles.map((p: { id: string }) => p.id);
    expect(profileIds).toContain('default');
    expect(profileIds).not.toContain('team');
    expect(profileIds).not.toContain('desktop');
  });

  it('internal member sees default + team, not desktop by default', async () => {
    const res = await fetch(`${BASE_URL}/api/profiles`, { headers: authHeaders(memberToken) });
    expect(res.status).toBe(200);
    const data = await res.json();
    const profileIds = data.profiles.map((p: { id: string }) => p.id);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('team');
    expect(profileIds).not.toContain('desktop');
  });
});

describe('E2E: Profile Access in Chat and Sessions', () => {
  it('external user cannot use team profile', async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: authHeaders(externalToken),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], profile_id: 'team' }),
    });
    expect([403, 429]).toContain(res.status);
  });

  it('external user can use default (public) profile', async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: authHeaders(externalToken),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], profile_id: 'default' }),
    });
    expect(res.status).not.toBe(403);
  });

  it('external user cannot use session mode', async () => {
    const sessionRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(superToken),
      body: JSON.stringify({ profile_id: 'default' }),
    });
    const session = await sessionRes.json();
    sessionsToClean.push({ id: session.id, token: superToken });

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: authHeaders(externalToken),
      body: JSON.stringify({ session_id: session.id, messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect([403, 429]).toContain(res.status);
  });
});
