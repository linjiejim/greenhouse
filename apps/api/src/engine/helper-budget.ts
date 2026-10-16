/** Helper reservations serialize against the same budget rows; usage remains the spending truth. */
import { and, eq, or, sql } from 'drizzle-orm';
import { budgetReservations, budgets, newId, transaction, usageEvents } from '@greenhouse/db';
import { ApiError } from '../http/errors.js';
import { currentMonth, measure, spentOf } from '../providers/budgets.js';

export const HELPER_RESERVED_TOKENS = 100_000;
export async function reserveHelpers(input: {
  memberId: string;
  agentId: string;
  providerId: string;
  runIds: string[];
  cost: number | null;
  personalCounting: readonly string[];
}) {
  await transaction(async (db) => {
    const month = currentMonth();
    const covering = await db
      .select()
      .from(budgets)
      .where(
        and(
          eq(budgets.enabled, true),
          or(
            eq(budgets.scopeType, 'workspace'),
            and(eq(budgets.scopeType, 'member'), eq(budgets.scopeId, input.memberId)),
            and(eq(budgets.scopeType, 'agent'), eq(budgets.scopeId, input.agentId)),
            and(eq(budgets.scopeType, 'provider'), eq(budgets.scopeId, input.providerId)),
          ),
        ),
      )
      .orderBy(budgets.id)
      .for('update');
    for (const budget of covering) {
      if (budget.unit === 'usd_micros' && input.cost === null)
        throw new ApiError(429, 'budget_estimate_unavailable', 'Helper runs need model prices for a cost budget.');
      const estimate = budget.unit === 'tokens' ? HELPER_RESERVED_TOKENS : input.cost!;
      const [held] = await db
        .select({ total: sql<string>`coalesce(sum(${budgetReservations.estimated}), 0)` })
        .from(budgetReservations)
        .where(
          and(
            eq(budgetReservations.budgetId, budget.id),
            eq(budgetReservations.status, 'reserved'),
            eq(budgetReservations.periodStart, month.start),
            sql`${budgetReservations.expiresAt} > now()`,
          ),
        );
      if (
        (await spentOf(budget, input.personalCounting, month)) +
          Number(held?.total ?? 0) +
          estimate * input.runIds.length >
        budget.monthlyLimit
      )
        throw new ApiError(429, 'budget_exceeded', 'There is not enough budget for these helper runs.');
    }
    for (const budget of covering.length ? covering : [{ id: `helper:${input.memberId}`, unit: 'tokens' }]) {
      await db
        .insert(budgetReservations)
        .values(
          input.runIds.map((runId) => ({
            id: newId('reservation'),
            budgetId: budget.id,
            periodStart: month.start,
            idempotencyKey: `helper:${runId}`,
            estimated: budget.unit === 'tokens' ? HELPER_RESERVED_TOKENS : input.cost!,
            memberId: input.memberId,
            runId,
            expiresAt: month.end,
          })),
        )
        .onConflictDoNothing();
    }
  });
}

export async function settleHelperBudget(runId: string) {
  await transaction(async (db) => {
    const rows = await db
      .select()
      .from(budgetReservations)
      .where(and(eq(budgetReservations.runId, runId), eq(budgetReservations.status, 'reserved')))
      .for('update');
    for (const reservation of rows) {
      const [budget] = await db.select().from(budgets).where(eq(budgets.id, reservation.budgetId));
      const [usage] = await db
        .select({ actual: measure(budget?.unit ?? 'tokens') })
        .from(usageEvents)
        .where(eq(usageEvents.runId, runId));
      const actual = Number(usage?.actual ?? 0);
      await db
        .update(budgetReservations)
        .set({ status: actual ? 'settled' : 'released', actual })
        .where(eq(budgetReservations.id, reservation.id));
    }
  });
}
