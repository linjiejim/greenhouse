/**
 * Services & pricing — the admin overview and budget writes (super), and the
 * member's own month (Settings › Usage).
 */

import type { BudgetLimitInput, MeteringOverview, MySpendReport, PriceOverrideInput } from '@greenhouse/types/metering';
import { rpc } from './client';

async function errorOf(res: Response, fallback: string): Promise<Error> {
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(typeof data?.error === 'string' ? data.error : fallback);
}

export async function fetchMeteringOverview(month?: string): Promise<MeteringOverview> {
  const res = await rpc.api.admin.metering.overview.$get({ query: month ? { month } : {} });
  if (!res.ok) throw await errorOf(res, `Failed to load services & pricing: ${res.status}`);
  return res.json();
}

export async function saveBudgetLimit(input: BudgetLimitInput): Promise<void> {
  const res = await rpc.api.admin.metering.budgets.$put({ json: input });
  if (!res.ok) throw await errorOf(res, `Failed to save the limit: ${res.status}`);
}

export async function resetBudgetLimit(scope: BudgetLimitInput['scope'], scopeId?: string): Promise<void> {
  const res = await rpc.api.admin.metering.budgets.$delete({
    query: { scope, ...(scopeId ? { scope_id: scopeId } : {}) },
  });
  if (!res.ok) throw await errorOf(res, `Failed to reset the limit: ${res.status}`);
}

export async function fetchMySpend(month?: string): Promise<MySpendReport> {
  const res = await rpc.api.usage.spend.$get({ query: month ? { month } : {} });
  if (!res.ok) throw await errorOf(res, `Failed to load your usage: ${res.status}`);
  return res.json();
}

export async function savePriceOverride(input: PriceOverrideInput): Promise<void> {
  const res = await rpc.api.admin.metering.prices.$put({ json: input });
  if (!res.ok) throw await errorOf(res, `Failed to save the price: ${res.status}`);
}

export async function resetPriceOverride(
  kind: PriceOverrideInput['kind'],
  target: string,
  provider?: string,
): Promise<void> {
  const res = await rpc.api.admin.metering.prices.$delete({
    query: { kind, target, ...(provider ? { provider } : {}) },
  });
  if (!res.ok) throw await errorOf(res, `Failed to reset the price: ${res.status}`);
}
