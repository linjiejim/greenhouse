/**
 * E2E — the member-wide background-task list over real HTTP
 * (`GET /api/bots/tasks?state=active`, docs/specs/20261010-mobile-live-activity.md §3.4):
 * the phone's Live Activities reconcile against it. Like every other Bots task route
 * it needs a session and the member's `bots` feature — the bare collection path is
 * guarded on its own in src/index.ts (`/api/bots/tasks/*` does not match it).
 *
 * Use `pnpm test:e2e:ci`; manual debugging setup is documented in tests/e2e/README.md.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, BASE_URL, createSuperToken, createTestToken } from './helpers.js';

let superToken: string;
let memberId: string | null = null;
let memberToken: string;

async function setBots(enabled: boolean): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/admin/users/${memberId}/features`, {
    method: 'PUT',
    headers: authHeaders(superToken),
    body: JSON.stringify({ feature: 'bots', enabled }),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/health`).catch(() => null);
  if (!res?.ok)
    throw new Error(`Server not running at ${BASE_URL}. Run pnpm test:e2e:ci or follow tests/e2e/README.md.`);
  superToken = createSuperToken();
  const created = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: authHeaders(superToken),
    body: JSON.stringify({
      email: `e2e-bots-tasks-${Date.now()}@test.local`,
      password: 'TestPass123!',
      nickname: 'E2E Bots Tasks',
      role: 'team',
    }),
  });
  expect(created.status).toBe(201);
  memberId = ((await created.json()) as { user: { id: string } }).user.id;
  memberToken = createTestToken(memberId, 'team');
});

afterAll(async () => {
  if (memberId) {
    await fetch(`${BASE_URL}/api/admin/users/${memberId}`, {
      method: 'DELETE',
      headers: authHeaders(superToken),
    }).catch(() => {});
  }
});

describe('E2E: the member-wide background-task list', () => {
  it('refuses a request without a session', async () => {
    expect((await fetch(`${BASE_URL}/api/bots/tasks?state=active`)).status).toBe(401);
  });

  it('lists a member’s tasks, and asks for the state it serves', async () => {
    await setBots(true);
    const res = await fetch(`${BASE_URL}/api/bots/tasks?state=active`, { headers: authHeaders(memberToken) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tasks: [] });
    const bare = await fetch(`${BASE_URL}/api/bots/tasks`, { headers: authHeaders(memberToken) });
    expect(bare.status).toBe(400);
  });

  it('is closed to a member whose bots feature is off, like the rest of the Bots task routes', async () => {
    await setBots(false);
    const res = await fetch(`${BASE_URL}/api/bots/tasks?state=active`, { headers: authHeaders(memberToken) });
    expect(res.status).toBe(403);
    expect(
      (await fetch(`${BASE_URL}/api/bots/tasks/run_x/cancel`, { method: 'POST', headers: authHeaders(memberToken) }))
        .status,
    ).toBe(403);
  });
});
