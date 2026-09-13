/**
 * Usage Budget concurrency integration tests.
 *
 * @db-commit-reason Concurrent reservation transactions must use independent
 * connections and observe committed account locks; a rollback-wrapped provider
 * cannot prove hard-limit admission or idempotent key serialization.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { cleanupUsageBudgetTestAccount, TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;
const accountIds: string[] = [];

async function createRunAccount(limitUnits: number) {
  const now = new Date();
  const account = await db.usageBudget.ensureAccount({
    scope_type: 'run',
    scope_id: `budget-race-${randomUUID()}`,
    period_start: new Date(now.getTime() - 60_000).toISOString(),
    period_end: new Date(now.getTime() + 60_000).toISOString(),
    limit_units: limitUnits,
  });
  accountIds.push(account.id);
  return account;
}

describe('Usage Budget concurrency', () => {
  beforeAll(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterAll(async () => {
    for (const accountId of accountIds) {
      await cleanupUsageBudgetTestAccount(db, accountId);
    }
    await db.close();
    _resetProvider();
  });

  it('admits exactly one contender when two reservations compete for the same remaining capacity', async () => {
    const account = await createRunAccount(100);
    const reserve = (suffix: string) =>
      db.usageBudget.reserve({
        account_ids: [account.id],
        idempotency_key: `capacity-race:${suffix}:${randomUUID()}`,
        estimated_units: 60,
        caller: 'workflow',
        run_id: account.scope_id,
        ttl_ms: 60_000,
      });

    const results = await Promise.allSettled([reserve('a'), reserve('b')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'usage_budget_exceeded' } });
    expect(await db.usageBudget.getAccount(account.id)).toMatchObject({ reserved_units: 60, spent_units: 0 });
    expect((await db.usageBudget.listLedger(account.id)).filter((row) => row.entry_type === 'reserve')).toHaveLength(1);
  });

  it('serializes concurrent retries of one idempotency key without double reserving', async () => {
    const account = await createRunAccount(100);
    const request = {
      account_ids: [account.id],
      idempotency_key: `same-key-race:${randomUUID()}`,
      estimated_units: 50,
      caller: 'mission',
      run_id: account.scope_id,
      ttl_ms: 60_000,
    } as const;

    const [left, right] = await Promise.all([db.usageBudget.reserve(request), db.usageBudget.reserve(request)]);
    expect(left[0]?.id).toBe(right[0]?.id);
    expect((await db.usageBudget.getAccount(account.id))?.reserved_units).toBe(50);
    expect((await db.usageBudget.listLedger(account.id)).filter((row) => row.entry_type === 'reserve')).toHaveLength(1);
  });
});
