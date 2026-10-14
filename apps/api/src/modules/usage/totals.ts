/**
 * Sums over usage_events, the only fact about usage. Every usage view (mine, an Agent's, the
 * workspace's, a public Agent's month) selects these columns, so a number means the same
 * everywhere.
 */

import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { UsagePeriod, UsageTotals } from '@greenhouse/contract';
import { usageEvents } from '@greenhouse/db';
import { currentMonth } from '../../providers/budgets.js';

const sum = (column: AnyPgColumn) => sql<string>`coalesce(sum(${column}), 0)::bigint`;

export const totalsColumns = {
  requests: sql<string>`count(*)::bigint`,
  input: sum(usageEvents.inputTokens),
  output: sum(usageEvents.outputTokens),
  cached: sum(usageEvents.cachedTokens),
  cost: sum(usageEvents.costMicros),
  unpriced: sql<string>`count(*) filter (where ${usageEvents.costMicros} is null)::bigint`,
};

type TotalsRow = { [K in keyof typeof totalsColumns]: string | number | null };

/** Postgres sums come back as text (bigint); empty sets as nothing. */
export function toTotals(row: TotalsRow | undefined): UsageTotals {
  const n = (value: string | number | null | undefined) => Number(value ?? 0);
  const input = n(row?.input);
  const output = n(row?.output);
  const cached = n(row?.cached);
  return {
    requests: n(row?.requests),
    input_tokens: input,
    output_tokens: output,
    cached_tokens: cached,
    cache_hit_rate: input ? Math.min(1, cached / input) : null,
    tokens: input + output,
    cost_micros: n(row?.cost),
    unpriced: n(row?.unpriced),
  };
}

export const emptyTotals = (): UsageTotals => toTotals(undefined);

const DAY_MS = 24 * 60 * 60 * 1000;

/** `month`: the current UTC month (the budget period). `30d`: the last 30 days. */
export function periodOf(name: UsagePeriod['name'], now = new Date()): UsagePeriod {
  const start = name === 'month' ? currentMonth(now).start : new Date(now.getTime() - 30 * DAY_MS).toISOString();
  return { name, start, end: now.toISOString() };
}

/** Every UTC day from the period's start to its end, as YYYY-MM-DD. */
export function daysOf(period: UsagePeriod): string[] {
  const days: string[] = [];
  const first = new Date(period.start);
  let day = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  const last = Date.parse(period.end);
  for (; day <= last; day += DAY_MS) days.push(new Date(day).toISOString().slice(0, 10));
  return days;
}
