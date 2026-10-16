/** Real commits verify two parents cannot reserve the same remaining member budget. */
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { budgetReservations, budgets, getDb, newId } from '@greenhouse/db';
import { reserveHelpers, HELPER_RESERVED_TOKENS } from '../helper-budget.js';

it('serializes concurrent helper budget reservations', async () => {
  const budgetId = newId('budget');
  const memberId = newId('member');
  const agentId = newId('agent');
  await getDb().insert(budgets).values({
    id: budgetId,
    scopeType: 'member',
    scopeId: memberId,
    unit: 'tokens',
    monthlyLimit: HELPER_RESERVED_TOKENS,
  });
  try {
    const input = { memberId, agentId, providerId: 'test', personalCounting: [], cost: null };
    const outcomes = await Promise.allSettled([
      reserveHelpers({ ...input, runIds: [newId('run')] }),
      reserveHelpers({ ...input, runIds: [newId('run')] }),
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      code: 'budget_exceeded',
    });
    expect(
      await getDb().select().from(budgetReservations).where(eq(budgetReservations.budgetId, budgetId)),
    ).toHaveLength(1);
  } finally {
    await getDb().delete(budgetReservations).where(eq(budgetReservations.budgetId, budgetId));
    await getDb().delete(budgets).where(eq(budgets.id, budgetId));
  }
});
