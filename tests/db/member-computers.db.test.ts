/**
 * The member_computers record: one active computer per member, a workspace-wide
 * concurrency limit counted under one lock, and compare-and-set transitions so
 * a stop or a block roll applies once.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let member: UserRow;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  member = await createInternalTestUser(db, { email: `${unique('computer')}@test.local` });
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

describe('member computers', () => {
  it('gives a member one active computer and returns it on the next claim', async () => {
    const first = await db.memberComputers.claimStart({ user_id: member.id, max_running: 100, client: 'mcp' });
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') throw new Error('expected a claim');
    expect(first.row).toMatchObject({ status: 'starting', user_id: member.id, client: 'mcp', minutes_billed: 0 });
    expect(first.row.id).toMatch(/^cmp_[0-9A-HJKMNP-TV-Z]{26}$/);

    const again = await db.memberComputers.claimStart({ user_id: member.id, max_running: 100, client: 'web' });
    expect(again).toMatchObject({ status: 'exists', row: { id: first.row.id } });
  });

  it('refuses a new computer once the workspace runs its limit', async () => {
    const active = (await db.memberComputers.listActive()).length;
    const other = await createInternalTestUser(db, { email: `${unique('computer-other')}@test.local` });
    await db.memberComputers.claimStart({ user_id: other.id, max_running: active + 1, client: 'web' });
    const refused = await db.memberComputers.claimStart({ user_id: member.id, max_running: active + 1, client: 'web' });
    expect(refused).toEqual({ status: 'full', running: active + 1 });
  });

  it('moves through running, a block roll and a stop exactly once each', async () => {
    const claim = await db.memberComputers.claimStart({ user_id: member.id, max_running: 100, client: 'web' });
    if (claim.status !== 'claimed') throw new Error('expected a claim');
    const id = claim.row.id;
    const running = await db.memberComputers.markRunning(id, {
      sandbox_id: 'sbx_1',
      budget_key: 'computer:k1',
      block_started_at: '2026-10-24T00:00:00.000Z',
    });
    expect(running).toMatchObject({ status: 'running', sandbox_id: 'sbx_1', budget_key: 'computer:k1' });
    const twice = await db.memberComputers.markRunning(id, {
      sandbox_id: 'x',
      budget_key: null,
      block_started_at: '2026-10-24T00:00:00.000Z',
    });
    expect(twice).toBeUndefined();

    const rolled = await db.memberComputers.rollBlock(id, {
      expected_budget_key: 'computer:k1',
      budget_key: 'computer:k2',
      block_started_at: '2026-10-24T00:15:00.000Z',
      add_minutes: 15,
    });
    expect(rolled).toMatchObject({ budget_key: 'computer:k2', minutes_billed: 15 });
    // A second process that settled the same block finds it already rolled.
    const stale = await db.memberComputers.rollBlock(id, {
      expected_budget_key: 'computer:k1',
      budget_key: 'computer:k3',
      block_started_at: '2026-10-24T00:15:00.000Z',
      add_minutes: 15,
    });
    expect(stale).toBeUndefined();

    expect(await db.memberComputers.claimStop(id)).toMatchObject({ status: 'stopping' });
    expect(await db.memberComputers.claimStop(id)).toBeUndefined();
    const stopped = await db.memberComputers.finish(id, {
      from: ['stopping'],
      status: 'stopped',
      stop_reason: 'user',
      add_minutes: 4,
    });
    expect(stopped).toMatchObject({ status: 'stopped', stop_reason: 'user', minutes_billed: 19, budget_key: null });
    expect(await db.memberComputers.getActiveForUser(member.id)).toBeUndefined();

    const next = await db.memberComputers.claimStart({ user_id: member.id, max_running: 100, client: 'web' });
    expect(next.status).toBe('claimed');
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
    expect(await db.memberComputers.minutesForUser(member.id, from, to)).toBe(19);
  });
});
