/**
 * Monthly budgets (docs/product/providers.md §8) at three levels: the workspace, one provider
 * instance, one member; in tokens or estimated US dollars (micros). What a budget has spent is
 * summed from usage_events for the current UTC month, the only fact about usage: the admin view
 * and the check before every call read the same sum.
 *
 * A call is refused while a budget that covers it is used up. The check runs before each attempt,
 * so calls already in flight can go past a limit by their own usage. Personal-key usage counts
 * toward the workspace and member budgets only where the capability's policy says so; a provider
 * budget counts everything its instance serves.
 */

import { and, eq, gte, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { budgetReservations, budgets, getDb, usageEvents, type BudgetRow } from '@greenhouse/db';
import { ApiError } from '../http/errors.js';

export const WORKSPACE_BUDGET_ID = 'default';
export type BudgetUnit = BudgetRow['unit'];
export type BudgetScope = BudgetRow['scopeType'];

/** The current UTC calendar month: the budget period. */
export function currentMonth(now = new Date()): { start: string; end: string } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  };
}

/** Usage a workspace or member budget counts: personal keys only for the capabilities listed. */
export function countedUsage(personalCounting: readonly string[]): SQL {
  return personalCounting.length
    ? or(ne(usageEvents.source, 'personal'), inArray(usageEvents.capability, [...personalCounting]))!
    : ne(usageEvents.source, 'personal');
}

/** What a unit sums over usage rows: input and output tokens, or the known cost. */
export function measure(unit: BudgetUnit) {
  return unit === 'tokens'
    ? sql<string>`coalesce(sum(coalesce(${usageEvents.inputTokens}, 0) + coalesce(${usageEvents.outputTokens}, 0)), 0)::bigint`
    : sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)::bigint`;
}

function covers(budget: Pick<BudgetRow, 'scopeType' | 'scopeId'>, personalCounting: readonly string[]): SQL {
  if (budget.scopeType === 'agent') return eq(usageEvents.agentId, budget.scopeId);
  if (budget.scopeType === 'provider') return eq(usageEvents.providerId, budget.scopeId);
  if (budget.scopeType === 'member')
    return and(eq(usageEvents.memberId, budget.scopeId), countedUsage(personalCounting))!;
  return countedUsage(personalCounting);
}

/** What a budget has spent this month. */
export async function spentOf(
  budget: Pick<BudgetRow, 'scopeType' | 'scopeId' | 'unit'>,
  personalCounting: readonly string[],
  month = currentMonth(),
): Promise<number> {
  const [row] = await getDb()
    .select({ spent: measure(budget.unit) })
    .from(usageEvents)
    .where(
      and(
        gte(usageEvents.createdAt, month.start),
        lt(usageEvents.createdAt, month.end),
        covers(budget, personalCounting),
      ),
    );
  return Number(row?.spent ?? 0);
}

export interface BudgetCheck {
  capability: string;
  instanceId: string;
  /** The instance is a member's own key. */
  personal: boolean;
  /** This capability's personal-key usage counts toward workspace and member budgets. */
  personalCounts: boolean;
  memberId?: string;
  agentId?: string;
  runId?: string;
  /** Every capability whose personal usage counts, for the sums; read only when a budget applies. */
  personalCounting: () => Promise<readonly string[]>;
}

/** Throws budget_exceeded (429) while an enabled budget covering this call is used up. */
export async function assertWithinBudgets(check: BudgetCheck): Promise<void> {
  const counted = !check.personal || check.personalCounts;
  const scopes = or(
    and(eq(budgets.scopeType, 'provider'), eq(budgets.scopeId, check.instanceId)),
    check.agentId ? and(eq(budgets.scopeType, 'agent'), eq(budgets.scopeId, check.agentId)) : undefined,
    counted ? eq(budgets.scopeType, 'workspace') : undefined,
    counted && check.memberId ? and(eq(budgets.scopeType, 'member'), eq(budgets.scopeId, check.memberId)) : undefined,
  );
  const rows = await getDb()
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.enabled, true),
        scopes,
        // Only model calls are measured in tokens; a cost limit covers every priced call.
        check.capability === 'llm' ? undefined : eq(budgets.unit, 'usd_micros'),
      ),
    );
  if (!rows.length) return;
  const personalCounting = await check.personalCounting();
  for (const budget of rows) {
    const [held] = await getDb()
      .select({ total: sql<string>`coalesce(sum(${budgetReservations.estimated}), 0)` })
      .from(budgetReservations)
      .where(
        and(
          eq(budgetReservations.budgetId, budget.id),
          eq(budgetReservations.status, 'reserved'),
          eq(budgetReservations.periodStart, currentMonth().start),
          sql`${budgetReservations.expiresAt} > now()`,
          check.runId ? ne(budgetReservations.runId, check.runId) : undefined,
        ),
      );
    if ((await spentOf(budget, personalCounting)) + Number(held?.total ?? 0) < budget.monthlyLimit) continue;
    const whose: Partial<Record<BudgetScope, string>> = {
      workspace: 'the workspace',
      provider: 'this service',
      member: 'your account',
      agent: 'this Agent',
    };
    throw new ApiError(
      429,
      'budget_exceeded',
      `The monthly budget of ${whose[budget.scopeType] ?? 'the workspace'} is used up. An admin can raise it.`,
      { scope_type: budget.scopeType, unit: budget.unit },
    );
  }
}
