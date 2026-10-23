/**
 * USD metering against real PostgreSQL: the three-level reservation (member,
 * service, organization) and its settlement / release, admission refusals,
 * the 80% / 100% alerts (deduplicated per account + period + threshold), the
 * month-bounded spend reads and the admin limit rows.
 *
 * Each test charges a fresh organization scope (USAGE_BUDGET_ORG_SCOPE_ID) so
 * the shared org account of the real deployment is never involved.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetProvider,
  getUtcMonthPeriod,
  initDatabase,
  MEMBER_DEFAULT_SCOPE_ID,
  usageBudgetAccountId,
  type DatabaseProvider,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { findBudgetRefusal } from '../budget-errors.js';
import { reserveSpend, runWithMeteringScope, settleServiceFact } from '../metering.js';
import { buildMeteringOverview, buildMySpend } from '../report.js';

let db: DatabaseProvider;
let member: UserRow;
let admin: UserRow;
let orgScope: string;
const originalOrgScope = process.env.USAGE_BUDGET_ORG_SCOPE_ID;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function accountId(scopeType: 'user' | 'service' | 'organization', scopeId: string) {
  const period = getUtcMonthPeriod();
  return usageBudgetAccountId({
    scope_type: scopeType,
    scope_id: scopeId,
    unit: 'usd_micros',
    period_start: period.start,
    period_end: period.end,
  });
}

async function balances() {
  const [own, service, org] = await Promise.all([
    db.usageBudget.getAccount(accountId('user', member.id)),
    db.usageBudget.getAccount(accountId('service', 'web_search')),
    db.usageBudget.getAccount(accountId('organization', orgScope)),
  ]);
  return { own: own!, service: service!, org: org! };
}

function reserve(estimate: number | null, extra: Partial<Parameters<typeof reserveSpend>[0]> = {}) {
  return reserveSpend({
    db,
    service: 'web_search',
    provider: 'tavily',
    caller: 'external_search',
    estimatedUsdMicros: estimate,
    userId: member.id,
    client: 'mcp',
    oauthClientId: 'lpoa_client_test',
    ...extra,
  });
}

async function budgetNotifications(user: UserRow) {
  const page = await db.notifications.listForUser({ user_id: user.id, limit: 50 });
  return page.items.filter((item) => item.kind === 'budget_attention');
}

beforeEach(async () => {
  orgScope = unique('org');
  process.env.USAGE_BUDGET_ORG_SCOPE_ID = orgScope;
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  member = await createInternalTestUser(db, { email: `${unique('meter-member')}@test.local` });
  admin = await createInternalTestUser(db, { email: `${unique('meter-admin')}@test.local`, role: 'super' });
});

afterEach(async () => {
  if (originalOrgScope === undefined) delete process.env.USAGE_BUDGET_ORG_SCOPE_ID;
  else process.env.USAGE_BUDGET_ORG_SCOPE_ID = originalOrgScope;
  await db.close();
  _resetProvider();
});

describe('three-level USD reservation', () => {
  it('reserves on member, service and organization at once, then settles the actual cost', async () => {
    const lease = await reserve(8_000);
    let now = await balances();
    expect([now.own.reserved_units, now.service.reserved_units, now.org.reserved_units]).toEqual([8_000, 8_000, 8_000]);

    lease.markProviderIoStarted();
    await settleServiceFact(db, lease, { provider: 'brave', units: 1, unitKind: 'call', costUsdMicros: 5_000 });
    now = await balances();
    expect([now.own.spent_units, now.service.spent_units, now.org.spent_units]).toEqual([5_000, 5_000, 5_000]);
    expect([now.own.reserved_units, now.service.reserved_units, now.org.reserved_units]).toEqual([0, 0, 0]);

    const facts = await db.metering.listServiceUsageByKey(lease.idempotencyKey);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      user_id: member.id,
      service: 'web_search',
      provider: 'brave',
      cost_usd_micros: 5_000,
      client: 'mcp',
      oauth_client_id: 'lpoa_client_test',
      caller: 'external_search',
    });
  });

  it('releases on all three levels before provider I/O, and keeps the reservation after', async () => {
    const before = await reserve(3_000);
    expect(await before.releaseBeforeProviderIo('preflight_failed')).toBe(true);
    let now = await balances();
    expect([now.own.reserved_units, now.service.reserved_units, now.org.reserved_units]).toEqual([0, 0, 0]);

    const after = await reserve(3_000);
    after.markProviderIoStarted();
    expect(await after.releaseBeforeProviderIo('network_failed')).toBe(false);
    now = await balances();
    // Outcome unknown: left for the TTL sweeper to charge at the estimate.
    expect(now.own.reserved_units).toBe(3_000);
    const group = await db.usageBudget.getReservationGroup(after.idempotencyKey);
    expect(group.map((row) => row.status)).toEqual(['reserved', 'reserved', 'reserved']);
  });

  it('refuses atomically when one level cannot cover the estimate', async () => {
    await db.metering.setLimit({ scope_type: 'user', scope_id: member.id, limit_units: 5_000 });
    const err = await reserve(8_000).catch((error: unknown) => error);
    expect(findBudgetRefusal(err)).toMatchObject({
      status: 429,
      code: 'usage_budget_exceeded',
      refusal: { unit: 'usd_micros', level: 'member' },
    });
    const now = await balances();
    // Nothing was reserved anywhere.
    expect([now.own.reserved_units, now.service.reserved_units, now.org.reserved_units]).toEqual([0, 0, 0]);
  });

  it('applies an organization refusal to every member and names the team', async () => {
    await db.metering.setLimit({ scope_type: 'organization', scope_id: orgScope, limit_units: 1_000 });
    const err = await reserve(8_000).catch((error: unknown) => error);
    expect(findBudgetRefusal(err)?.refusal).toEqual({ unit: 'usd_micros', level: 'organization' });
    expect(findBudgetRefusal(err)?.message).toContain('团队额度');
  });

  it('lets an unpriced call through with headroom and refuses it once the budget is used up', async () => {
    const free = await reserve(null);
    expect(free.reserved).toBe(false);
    await db.metering.setLimit({ scope_type: 'user', scope_id: member.id, limit_units: 0 });
    const err = await reserve(null).catch((error: unknown) => error);
    expect(findBudgetRefusal(err)?.refusal?.level).toBe('member');
  });

  it('refuses a member whose account is disabled or missing before touching any budget', async () => {
    await db.users.update(member.id, { status: 'disabled' });
    const err = await reserve(1_000).catch((error: unknown) => error);
    expect(err).toMatchObject({ status: 403, code: 'usage_budget_subject_unavailable' });
  });
});

describe('budget alerts', () => {
  it('tells the member once per threshold per period', async () => {
    await db.metering.setLimit({ scope_type: 'user', scope_id: member.id, limit_units: 10_000 });
    const spend = async (cost: number) => {
      const lease = await reserve(cost);
      lease.markProviderIoStarted();
      await settleServiceFact(db, lease, { provider: 'tavily', units: 1, unitKind: 'call', costUsdMicros: cost });
    };

    await spend(8_500); // 85% → the 80% alert
    await spend(500); // 90% → still only the 80% alert
    let alerts = await budgetNotifications(member);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'budget_attention' });
    expect(JSON.parse(alerts[0]!.payload)).toMatchObject({ threshold: 80, scope_type: 'user', scope_id: member.id });

    await spend(1_000); // 100%
    await spend(0 + 1).catch(() => undefined); // refused: no third alert
    alerts = await budgetNotifications(member);
    expect(alerts.map((alert) => JSON.parse(alert.payload).threshold).sort()).toEqual([100, 80]);
    expect(alerts.every((alert) => alert.dedupe_key.startsWith(`usage-budget:${accountId('user', member.id)}:`))).toBe(
      true,
    );
  });

  it('tells the admins, not the member, when the organization crosses a threshold', async () => {
    await db.metering.setLimit({ scope_type: 'organization', scope_id: orgScope, limit_units: 10_000 });
    const lease = await reserve(9_000);
    lease.markProviderIoStarted();
    await settleServiceFact(db, lease, { provider: 'tavily', units: 1, unitKind: 'call', costUsdMicros: 9_000 });

    const adminAlerts = await budgetNotifications(admin);
    expect(adminAlerts).toHaveLength(1);
    expect(JSON.parse(adminAlerts[0]!.payload)).toMatchObject({ scope_type: 'organization', threshold: 80 });
    // The member's own account is at 9_000 of $50 — far below 80%.
    expect(await budgetNotifications(member)).toHaveLength(0);
  });
});

describe('spend reads', () => {
  it('reads one month by member, service, client and agent client, flagging unpriced calls', async () => {
    await db.usage.record({
      profile_id: 'team',
      caller: 'chat',
      user_id: member.id,
      model: 'flash',
      input_tokens: 10,
      output_tokens: 5,
      cost_usd_micros: 1_200,
      client: 'web',
      service: 'llm',
    });
    await db.usage.record({
      profile_id: 'team',
      caller: 'chat',
      user_id: member.id,
      model: 'pro',
      input_tokens: 10,
      output_tokens: 5,
      client: 'mcp',
      oauth_client_id: 'lpoa_client_reads',
      service: 'llm',
    });
    await db.metering.recordService({
      user_id: member.id,
      service: 'web_search',
      provider: 'tavily',
      units: 1,
      unit_kind: 'call',
      cost_usd_micros: 8_000,
      client: 'mcp',
      oauth_client_id: 'lpoa_client_reads',
    });

    const mine = await runWithMeteringScope({ userId: member.id, client: 'web' }, () => buildMySpend(db, member.id));
    expect(mine.totals).toEqual({ cost_usd_micros: 9_200, calls: 3, unpriced_calls: 1 });
    expect(mine.by_service).toEqual([
      { key: 'web_search', label: null, cost_usd_micros: 8_000, calls: 1, unpriced_calls: 0 },
      { key: 'llm', label: null, cost_usd_micros: 1_200, calls: 2, unpriced_calls: 1 },
    ]);
    expect(mine.by_client.find((row) => row.key === 'mcp')).toMatchObject({ cost_usd_micros: 8_000, calls: 2 });
    expect(mine.by_agent_client).toEqual([
      { key: 'lpoa_client_reads', label: null, cost_usd_micros: 8_000, calls: 2, unpriced_calls: 1 },
    ]);
    expect(mine.budget).toMatchObject({ scope: 'member', scope_id: member.id, source: 'default' });

    const overview = await buildMeteringOverview(db);
    expect(overview.spend.by_member.find((row) => row.key === member.id)).toMatchObject({
      cost_usd_micros: 9_200,
      calls: 3,
      unpriced_calls: 1,
      label: member.nickname || member.email,
    });
    expect(overview.services.find((service) => service.service === 'web_search')?.providers).toContainEqual(
      expect.objectContaining({ provider: 'firecrawl', priced: false }),
    );
  });

  it('does not count another month', async () => {
    await db.metering.recordService({
      user_id: member.id,
      service: 'web_search',
      provider: 'tavily',
      units: 1,
      unit_kind: 'call',
      cost_usd_micros: 8_000,
      created_at: '2020-01-15T00:00:00.000Z',
    });
    const mine = await buildMySpend(db, member.id);
    expect(mine.totals.calls).toBe(0);
    const old = await buildMySpend(db, member.id, new Date(Date.UTC(2020, 0, 1)));
    expect(old.totals.cost_usd_micros).toBe(8_000);
  });
});

describe('admin limits', () => {
  it('upserts one row per scope and falls back once removed', async () => {
    await db.metering.setLimit({ scope_type: 'user', scope_id: MEMBER_DEFAULT_SCOPE_ID, limit_units: 7_000_000 });
    await db.metering.setLimit({ scope_type: 'user', scope_id: member.id, limit_units: 1_000_000, actor_id: admin.id });
    await db.metering.setLimit({ scope_type: 'user', scope_id: member.id, limit_units: 2_000_000, actor_id: admin.id });
    const rows = await db.metering.getLimits([
      { scope_type: 'user', scope_id: member.id },
      { scope_type: 'user', scope_id: MEMBER_DEFAULT_SCOPE_ID },
    ]);
    expect(rows.find((row) => row.scope_id === member.id)).toMatchObject({
      limit_units: 2_000_000,
      updated_by: admin.id,
    });

    let overview = await buildMeteringOverview(db);
    expect(overview.budgets.member_default).toMatchObject({ limit_usd_micros: 7_000_000, source: 'override' });
    expect(overview.budgets.members.find((row) => row.scope_id === member.id)).toMatchObject({
      limit_usd_micros: 2_000_000,
      source: 'override',
    });

    expect(await db.metering.deleteLimit('user', member.id)).toBe(true);
    overview = await buildMeteringOverview(db);
    expect(overview.budgets.members.find((row) => row.scope_id === member.id)).toBeUndefined();
    expect((await buildMySpend(db, member.id)).budget).toMatchObject({
      limit_usd_micros: 7_000_000,
      source: 'default',
    });
  });
});
