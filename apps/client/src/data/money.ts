/** USD micros as people read them, like the web (apps/web/src/lib/metering/format.ts). React-free. */

export const USD_MICROS = 1_000_000;

export function formatUsd(micros: number): string {
  if (!Number.isFinite(micros)) return '$0.00';
  const usd = micros / USD_MICROS;
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** What is left of a budget (never below zero), counting reserved spend as used. */
export function budgetLeft(budget: { limit_usd_micros: number; spent_usd_micros: number; reserved_usd_micros?: number }): number {
  return Math.max(0, budget.limit_usd_micros - budget.spent_usd_micros - (budget.reserved_usd_micros ?? 0));
}

/** Share of a budget used, 0..1 (a zero limit with any spend reads as used up). */
export function budgetShare(budget: { limit_usd_micros: number; spent_usd_micros: number }): number {
  if (budget.limit_usd_micros <= 0) return budget.spent_usd_micros > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, budget.spent_usd_micros / budget.limit_usd_micros));
}
