/**
 * E2E Security Tests — Profile Access Control.
 *
 * Use `pnpm test:e2e:ci`; manual debugging setup is documented in tests/e2e/README.md.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSuperToken, createTestToken, BASE_URL, authHeaders } from './helpers.js';

let superToken: string;
let memberToken: string;
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
    throw new Error(`Server not running at ${BASE_URL}. Run pnpm test:e2e:ci or follow tests/e2e/README.md.`);
  }

  superToken = createSuperToken();
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
  it('requires authentication', async () => {
    const res = await fetch(`${BASE_URL}/api/profiles`);
    expect(res.status).toBe(401);
  });

  it('internal member sees the selectable presets — not retired ids, judges or runtimes', async () => {
    const res = await fetch(`${BASE_URL}/api/profiles`, { headers: authHeaders(memberToken) });
    expect(res.status).toBe(200);
    const data = await res.json();
    const profileIds = data.profiles.map((p: { id: string }) => p.id);
    // One preset since 2026-08-01: quick/deep/K3 were one assistant on three
    // engines, so the engine became a per-turn choice and the copies collapsed.
    expect(profileIds).toEqual(['sprouty']);
    // The models moved here — that list is what the picker offers.
    expect(data.models.map((m: { id: string }) => m.id)).toContain('flash');
    for (const retired of ['team', 'default', 'sprouty-quick', 'sprouty-deep', 'sprouty-k3', 'sprouty-workflows', 'sprouty-mission']) {
      expect(profileIds, retired).not.toContain(retired);
    }
    // Machinery, not agents: resolvable by id server-side but never offered here.
    expect(profileIds).not.toContain('eval-judge');
    expect(profileIds).not.toContain('desktop');
  });
});

describe('E2E: Profile Access in Chat and Sessions', () => {
  it('unauthenticated caller cannot use chat', async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '192.0.2.40' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], profile_id: 'team' }),
    });
    expect(res.status).toBe(401);
  });

  it('hidden integration profile cannot be used through cloud chat', async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: authHeaders(superToken),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], profile_id: 'desktop' }),
    });
    expect([403, 429]).toContain(res.status);
  });

  it('hidden integration profile cannot create a cloud session', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(superToken),
      body: JSON.stringify({ profile_id: 'desktop' }),
    });
    expect(res.status).toBe(403);
  });

  it('maps the removed default profile ID to team for legacy session data', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: authHeaders(memberToken),
      body: JSON.stringify({ profile_id: 'default' }),
    });
    expect(res.status).toBe(201);
    const session = await res.json();
    expect(session.profile_id).toBe('sprouty');
    sessionsToClean.push({ id: session.id, token: memberToken });
  });
});
