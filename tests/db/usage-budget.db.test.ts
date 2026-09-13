/**
 * Unified Usage Budget service integration tests.
 *
 * Covers account materialization, atomic multi-scope reservation, hard-limit
 * enforcement, idempotent settlement/release, TTL expiry, and append-only
 * ledger history against PostgreSQL.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, getUtcMonthPeriod, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let user: UserRow;

function key(label: string): string {
  return `${label}:${Date.now()}:${Math.random()}`;
}

async function monthlyAccount(limitTokens = 1_000) {
  user = (await db.users.update(user.id, { monthly_token_limit: limitTokens }))!;
  return db.usageBudget.ensureMonthlyUserAccount({
    user_id: user.id,
    limit_tokens: limitTokens,
    sync_limit: true,
  });
}

describe('Usage Budget Service', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `budget-${Date.now()}-${Math.random()}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('materializes the monthly user account from permanent legacy usage', async () => {
    await db.usage.record({
      profile_id: 'team',
      caller: 'chat',
      user_id: user.id,
      model: 'pro',
      input_tokens: 120,
      output_tokens: 30,
    });

    const account = await monthlyAccount(1_000);
    expect(account.scope_type).toBe('user');
    expect(account.scope_id).toBe(user.id);
    expect(account.spent_units).toBe(150);
    expect(account.reserved_units).toBe(0);

    const ledger = await db.usageBudget.listLedger(account.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ entry_type: 'bootstrap', delta_spent_units: 150 });

    const updatedLimit = await monthlyAccount(900);
    expect(updatedLimit.id).toBe(account.id);
    expect(updatedLimit.limit_units).toBe(900);
    expect((await db.usageBudget.listLedger(account.id))[0]?.entry_type).toBe('adjustment');
  });

  it('does not let a stale request copy raise an administrator-lowered limit', async () => {
    const account = await monthlyAccount(1_000);
    user = (await db.users.update(user.id, { monthly_token_limit: 400 }))!;
    const lowered = await db.usageBudget.ensureMonthlyUserAccount({
      user_id: user.id,
      limit_tokens: 400,
      sync_limit: true,
    });
    expect(lowered.limit_units).toBe(400);

    const staleRequest = await db.usageBudget.ensureMonthlyUserAccount({
      user_id: user.id,
      limit_tokens: 1_000,
    });
    expect(staleRequest.id).toBe(account.id);
    expect(staleRequest.limit_units).toBe(400);
    expect((await db.usageBudget.getAccount(account.id))?.limit_units).toBe(400);
  });

  it('keeps generic account limits create-only unless control-plane sync is explicit', async () => {
    const period = getUtcMonthPeriod();
    const input = {
      scope_type: 'provider' as const,
      scope_id: `provider-create-only-${user.id}`,
      period_start: period.start,
      period_end: period.end,
      limit_units: 1_000,
    };
    const created = await db.usageBudget.ensureAccount(input);
    const stale = await db.usageBudget.ensureAccount({ ...input, limit_units: 2_000 });
    expect(stale.id).toBe(created.id);
    expect(stale.limit_units).toBe(1_000);

    const synchronized = await db.usageBudget.ensureAccount({
      ...input,
      limit_units: 2_000,
      update_existing_limit: true,
    });
    expect(synchronized.limit_units).toBe(2_000);
  });

  it('reserves multiple scope accounts atomically and reuses the exact idempotency key', async () => {
    const period = getUtcMonthPeriod();
    const [userAccount, organizationAccount] = await Promise.all([
      monthlyAccount(1_000),
      db.usageBudget.ensureAccount({
        scope_type: 'organization',
        scope_id: 'default',
        period_start: period.start,
        period_end: period.end,
        limit_units: 2_000,
      }),
    ]);
    const idempotencyKey = key('multi-scope');
    const request = {
      account_ids: [organizationAccount.id, userAccount.id],
      idempotency_key: idempotencyKey,
      estimated_units: 200,
      caller: 'workflow',
      user_id: user.id,
      run_id: 'run-1',
      ttl_ms: 60_000,
    } as const;

    const first = await db.usageBudget.reserve(request);
    const duplicate = await db.usageBudget.reserve(request);
    expect(first.map((row) => row.id)).toEqual(duplicate.map((row) => row.id));
    expect(first).toHaveLength(2);
    expect((await db.usageBudget.getAccount(userAccount.id))?.reserved_units).toBe(200);
    expect((await db.usageBudget.getAccount(organizationAccount.id))?.reserved_units).toBe(200);
    expect(
      (await db.usageBudget.listLedger(userAccount.id)).filter((row) => row.entry_type === 'reserve'),
    ).toHaveLength(1);

    await expect(db.usageBudget.reserve({ ...request, estimated_units: 201 })).rejects.toMatchObject({
      code: 'usage_budget_idempotency_conflict',
    });
    await expect(db.usageBudget.reserve({ ...request, ttl_ms: 120_000 })).rejects.toMatchObject({
      code: 'usage_budget_idempotency_conflict',
    });
  });

  it('supports run/provider scope units and rejects mixed-unit reservation groups atomically', async () => {
    const period = getUtcMonthPeriod();
    const [runRequests, providerCost] = await Promise.all([
      db.usageBudget.ensureAccount({
        scope_type: 'run',
        scope_id: 'run-mixed-unit',
        unit: 'requests',
        period_start: period.start,
        period_end: period.end,
        limit_units: 10,
      }),
      db.usageBudget.ensureAccount({
        scope_type: 'provider',
        scope_id: 'openrouter',
        unit: 'usd_micros',
        period_start: period.start,
        period_end: period.end,
        limit_units: 1_000_000,
      }),
    ]);
    await expect(
      db.usageBudget.reserve({
        account_ids: [runRequests.id, providerCost.id],
        idempotency_key: key('mixed-unit'),
        estimated_units: 1,
        caller: 'relay',
        ttl_ms: 60_000,
      }),
    ).rejects.toMatchObject({ code: 'usage_budget_invalid_input' });
    expect((await db.usageBudget.getAccount(runRequests.id))?.reserved_units).toBe(0);
    expect((await db.usageBudget.getAccount(providerCost.id))?.reserved_units).toBe(0);
  });

  it('fails closed for missing, disabled, and exhausted accounts without a partial debit', async () => {
    await expect(
      db.usageBudget.reserve({
        account_ids: ['missing-account'],
        idempotency_key: key('missing'),
        estimated_units: 1,
        caller: 'chat',
        ttl_ms: 60_000,
      }),
    ).rejects.toMatchObject({ code: 'usage_budget_account_unavailable' });

    const exhausted = await monthlyAccount(100);
    await expect(
      db.usageBudget.reserve({
        account_ids: [exhausted.id],
        idempotency_key: key('exhausted'),
        estimated_units: 101,
        caller: 'chat',
        user_id: user.id,
        ttl_ms: 60_000,
      }),
    ).rejects.toMatchObject({ code: 'usage_budget_exceeded' });
    expect((await db.usageBudget.getAccount(exhausted.id))?.reserved_units).toBe(0);

    await db.usageBudget.setAccountStatus({
      account_id: exhausted.id,
      status: 'disabled',
      idempotency_key: key('disable'),
      reason: 'test_hard_stop',
      actor_id: user.id,
    });
    await expect(
      db.usageBudget.reserve({
        account_ids: [exhausted.id],
        idempotency_key: key('disabled'),
        estimated_units: 1,
        caller: 'chat',
        user_id: user.id,
        ttl_ms: 60_000,
      }),
    ).rejects.toMatchObject({ code: 'usage_budget_account_unavailable' });
  });

  it('settles actual usage exactly once and preserves every ledger transition', async () => {
    const account = await monthlyAccount(1_000);
    const idempotencyKey = key('settle');
    await db.usageBudget.reserve({
      account_ids: [account.id],
      idempotency_key: idempotencyKey,
      estimated_units: 300,
      caller: 'mission',
      user_id: user.id,
      provider_id: 'openrouter',
      model_id: 'pro',
      ttl_ms: 60_000,
    });

    const settled = await db.usageBudget.settle({ idempotency_key: idempotencyKey, actual_units: 220 });
    expect(settled[0]).toMatchObject({ status: 'settled', actual_units: 220 });
    await db.usageBudget.settle({ idempotency_key: idempotencyKey, actual_units: 220 });
    await expect(db.usageBudget.settle({ idempotency_key: idempotencyKey, actual_units: 221 })).rejects.toMatchObject({
      code: 'usage_budget_idempotency_conflict',
    });

    const snapshot = await db.usageBudget.getAccountSnapshot(account.id);
    expect(snapshot).toMatchObject({ available_units: 780, exceeded: false });
    expect(snapshot?.account).toMatchObject({ reserved_units: 0, spent_units: 220 });
    expect((await db.usageBudget.listLedger(account.id)).map((row) => row.entry_type).reverse()).toEqual([
      'bootstrap',
      'reserve',
      'settle',
    ]);
  });

  it('releases capacity idempotently and still accounts for a late provider settlement', async () => {
    const account = await monthlyAccount(1_000);
    const idempotencyKey = key('release');
    await db.usageBudget.reserve({
      account_ids: [account.id],
      idempotency_key: idempotencyKey,
      estimated_units: 100,
      caller: 'automation',
      user_id: user.id,
      ttl_ms: 60_000,
    });
    await db.usageBudget.release({ idempotency_key: idempotencyKey, reason: 'provider_request_not_started' });
    await db.usageBudget.release({ idempotency_key: idempotencyKey, reason: 'provider_request_not_started' });
    await expect(
      db.usageBudget.release({ idempotency_key: idempotencyKey, reason: 'different_release_reason' }),
    ).rejects.toMatchObject({ code: 'usage_budget_idempotency_conflict' });
    expect((await db.usageBudget.getAccount(account.id))?.reserved_units).toBe(0);

    // A delayed usage response after release must be recorded truthfully; it
    // adds spent units without subtracting the already-released reservation.
    await db.usageBudget.settle({ idempotency_key: idempotencyKey, actual_units: 40 });
    expect(await db.usageBudget.getReservationGroup(idempotencyKey)).toMatchObject([
      { status: 'settled', actual_units: 40 },
    ]);
    expect((await db.usageBudget.getAccount(account.id))?.spent_units).toBe(40);
    expect((await db.usageBudget.listLedger(account.id)).map((row) => row.entry_type).reverse()).toEqual([
      'bootstrap',
      'reserve',
      'release',
      'settle',
    ]);
  });

  it('charges stale unknown reservations conservatively, then applies a late actual-usage correction', async () => {
    const at = new Date();
    const account = await monthlyAccount(1_000);
    const idempotencyKey = key('expire');
    await db.usageBudget.reserve({
      account_ids: [account.id],
      idempotency_key: idempotencyKey,
      estimated_units: 75,
      caller: 'subagent',
      user_id: user.id,
      ttl_ms: 1_000,
      at,
    });

    expect(await db.usageBudget.expireStaleReservations(new Date(at.getTime() + 2_000))).toBe(1);
    expect(await db.usageBudget.getReservationGroup(idempotencyKey)).toMatchObject([
      { status: 'expired', actual_units: 75 },
    ]);
    expect(await db.usageBudget.getAccount(account.id)).toMatchObject({ reserved_units: 0, spent_units: 75 });
    expect((await db.usageBudget.listLedger(account.id)).map((row) => row.entry_type)).toContain('expire');

    await expect(
      db.usageBudget.release({ idempotency_key: idempotencyKey, reason: 'too_late_to_release' }),
    ).rejects.toMatchObject({ code: 'usage_budget_invalid_state' });
    await db.usageBudget.settle({ idempotency_key: idempotencyKey, actual_units: 50 });
    expect((await db.usageBudget.getAccount(account.id))?.spent_units).toBe(50);
    expect((await db.usageBudget.listLedger(account.id))[0]).toMatchObject({
      entry_type: 'settle',
      delta_spent_units: -25,
    });
  });

  it('applies manual reconciliation adjustments once per idempotency key', async () => {
    const account = await monthlyAccount(1_000);
    const idempotencyKey = key('adjust');
    await db.usageBudget.adjustSpent({
      account_id: account.id,
      idempotency_key: idempotencyKey,
      delta_spent_units: 25,
      reason: 'provider_invoice_reconciliation',
      actor_id: user.id,
    });
    await db.usageBudget.adjustSpent({
      account_id: account.id,
      idempotency_key: idempotencyKey,
      delta_spent_units: 25,
      reason: 'provider_invoice_reconciliation',
      actor_id: user.id,
    });
    expect((await db.usageBudget.getAccount(account.id))?.spent_units).toBe(25);
    expect((await db.usageBudget.listLedger(account.id)).filter((row) => row.entry_type === 'adjustment')).toHaveLength(
      1,
    );
    await expect(
      db.usageBudget.adjustSpent({
        account_id: account.id,
        idempotency_key: idempotencyKey,
        delta_spent_units: 30,
        reason: 'provider_invoice_reconciliation',
        actor_id: user.id,
      }),
    ).rejects.toMatchObject({ code: 'usage_budget_idempotency_conflict' });
  });

  it('keeps linked budget-aware usage out of the legacy projection', async () => {
    await db.usage.record({
      profile_id: 'team',
      caller: 'chat',
      user_id: user.id,
      model: 'pro',
      input_tokens: 80,
      output_tokens: 20,
    });
    const account = await monthlyAccount(1_000);
    const firstKey = key('linked');
    await db.usageBudget.reserve({
      account_ids: [account.id],
      idempotency_key: firstKey,
      estimated_units: 200,
      caller: 'chat',
      user_id: user.id,
      ttl_ms: 60_000,
    });
    await db.usage.record({
      profile_id: 'team',
      caller: 'chat',
      user_id: user.id,
      model: 'pro',
      input_tokens: 120,
      output_tokens: 30,
      budget_idempotency_key: firstKey,
    });
    await db.usageBudget.settle({ idempotency_key: firstKey, actual_units: 150 });

    const secondKey = key('after-linked');
    await db.usageBudget.reserve({
      account_ids: [account.id],
      idempotency_key: secondKey,
      estimated_units: 10,
      caller: 'chat',
      user_id: user.id,
      ttl_ms: 60_000,
    });
    expect(await db.usageBudget.getAccount(account.id)).toMatchObject({
      spent_units: 250,
      legacy_spent_units: 100,
      reserved_units: 10,
    });
  });

  it('audits idempotent account status changes and rejects drift', async () => {
    const account = await monthlyAccount(1_000);
    const idempotencyKey = key('status');
    const request = {
      account_id: account.id,
      status: 'disabled' as const,
      idempotency_key: idempotencyKey,
      reason: 'incident_kill_switch',
      actor_id: user.id,
    };
    await db.usageBudget.setAccountStatus(request);
    await db.usageBudget.setAccountStatus(request);
    expect((await db.usageBudget.listLedger(account.id)).filter((row) => row.entry_type === 'status')).toHaveLength(1);
    await expect(db.usageBudget.setAccountStatus({ ...request, reason: 'different_reason' })).rejects.toMatchObject({
      code: 'usage_budget_idempotency_conflict',
    });
  });
});
