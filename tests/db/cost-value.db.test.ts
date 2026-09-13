/** Cost/value operating report integration tests (real PostgreSQL). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, getUtcMonthPeriod, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let user: UserRow;

function unique(label: string) {
  return `${label}:${Date.now()}:${Math.random()}`;
}

describe('Cost/value operating report', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `cost-value-${Date.now()}-${Math.random()}@test.local` });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('aggregates exact Agent versions, terminal Runtime value and non-duplicated actual USD ledger facts', async () => {
    // The report must preserve the immutable reference even if its asset was
    // later removed; permanent usage evidence cannot depend on a live FK.
    const profileRef = 'custom:999999@3';
    const run = await db.runtime.createRun({
      kind: 'eval',
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      source_kind: 'eval_run',
      source_id: unique('eval-source'),
      input: { dataset: 'regression-v1' },
    });
    const workerId = unique('cost-value-worker');
    const claimed = await db.runtime.claimNextRun({
      worker_id: workerId,
      lease_ms: 60_000,
      kinds: ['eval'],
    });
    expect(claimed?.id).toBe(run.id);
    const running = await db.runtime.transitionRun({
      id: run.id,
      expected_version: claimed!.version,
      to_status: 'running',
      idempotency_key: unique('running'),
      worker_id: workerId,
      lease_ms: 60_000,
    });
    await db.runtime.transitionRun({
      id: run.id,
      expected_version: running.version,
      to_status: 'succeeded',
      idempotency_key: unique('succeeded'),
      worker_id: workerId,
      lease_ms: 60_000,
      output: { passed: true },
    });

    const period = getUtcMonthPeriod();
    const [userUsd, organizationUsd] = await Promise.all([
      db.usageBudget.ensureAccount({
        scope_type: 'user',
        scope_id: user.id,
        unit: 'usd_micros',
        period_start: period.start,
        period_end: period.end,
        limit_units: 1_000_000,
      }),
      db.usageBudget.ensureAccount({
        scope_type: 'organization',
        scope_id: 'default',
        unit: 'usd_micros',
        period_start: period.start,
        period_end: period.end,
        limit_units: 10_000_000,
      }),
    ]);
    const budgetKey = unique('image-budget');
    await db.usageBudget.reserve({
      account_ids: [userUsd.id, organizationUsd.id],
      idempotency_key: budgetKey,
      estimated_units: 6_000,
      caller: 'generate_image',
      user_id: user.id,
      run_id: run.id,
      provider_id: 'media',
      model_id: 'gpt-image-2',
      ttl_ms: 60_000,
    });
    await db.usageBudget.settle({ idempotency_key: budgetKey, actual_units: 5_000 });
    await db.usage.record({
      profile_id: profileRef,
      caller: 'eval',
      user_id: user.id,
      model: 'flash',
      input_tokens: 700,
      output_tokens: 300,
      cached_tokens: 100,
      reasoning_tokens: 50,
      duration_ms: 1_250,
      budget_idempotency_key: budgetKey,
    });

    const report = await db.usage.getCostValueReport({
      since: period.start,
      until: new Date(Date.now() + 60_000).toISOString(),
      run_limit: 10,
    });

    expect(report.accounting).toEqual({
      token_cost_estimate: null,
      token_cost_estimate_reason: 'provider_prices_unavailable',
      usd_source: 'usage_budget_ledger',
    });
    expect(report.organization).toMatchObject({
      total_calls: 1,
      total_tokens: 1_000,
      total_duration_ms: 1_250,
      runtime_runs: 1,
      runtime_terminal_runs: 1,
      runtime_succeeded_runs: 1,
      effective_completion_rate: 1,
      // The same image debit hit user + organization accounts. Organization
      // reporting selects only organization scope, so it is not doubled.
      actual_usd_micros: 5_000,
      cost_estimate_usd: null,
    });
    expect(report.agents[0]).toMatchObject({
      profile_id: profileRef,
      agent_id: 'custom:999999',
      agent_version: 3,
      name: profileRef,
      total_tokens: 1_000,
      actual_usd_micros: 5_000,
    });
    expect(report.users[0]).toMatchObject({
      user_id: user.id,
      total_calls: 1,
      total_tokens: 1_000,
      actual_usd_micros: 5_000,
    });
    expect(report.runtime_by_kind).toContainEqual(
      expect.objectContaining({
        kind: 'eval',
        total_runs: 1,
        terminal_runs: 1,
        llm_calls: 1,
        llm_tokens: 1_000,
        actual_usd_micros: 5_000,
        effective_completion_rate: 1,
      }),
    );
    expect(report.recent_runs[0]).toMatchObject({
      id: run.id,
      llm_calls: 1,
      llm_tokens: 1_000,
      status: 'succeeded',
      actual_usd_micros: 5_000,
    });
    expect(report.budgets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: organizationUsd.id,
          spent_units: 5_000,
          reserved_units: 0,
          available_units: 9_995_000,
        }),
      ]),
    );
  });
});
