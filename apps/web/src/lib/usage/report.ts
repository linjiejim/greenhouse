/**
 * Pure shaping of the module usage report for Administration › Usage.
 */

import type { ModelCacheHitRow, UsageCountRow } from '@greenhouse/types/usage';

export interface KeyTotal {
  key: string;
  total: number;
  /** Per-client counts, largest first. */
  clients: Array<{ client: string; count: number }>;
}

/** Collapse key × client rows into one row per key, largest total first. */
export function totalsByKey(rows: readonly UsageCountRow[]): KeyTotal[] {
  const byKey = new Map<string, KeyTotal>();
  for (const row of rows) {
    const entry = byKey.get(row.key) ?? { key: row.key, total: 0, clients: [] };
    entry.total += row.count;
    entry.clients.push({ client: row.client, count: row.count });
    byKey.set(row.key, entry);
  }
  const totals = [...byKey.values()];
  for (const entry of totals) entry.clients.sort((a, b) => b.count - a.count || a.client.localeCompare(b.client));
  return totals.sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

export interface ClientTotal {
  client: string;
  toolCalls: number;
  pageOpens: number;
}

/** One row per client across both kinds, busiest first. */
export function totalsByClient(
  toolCalls: readonly UsageCountRow[],
  pageOpens: readonly UsageCountRow[],
): ClientTotal[] {
  const byClient = new Map<string, ClientTotal>();
  const entry = (client: string) => {
    const existing = byClient.get(client);
    if (existing) return existing;
    const created = { client, toolCalls: 0, pageOpens: 0 };
    byClient.set(client, created);
    return created;
  };
  for (const row of toolCalls) entry(row.client).toolCalls += row.count;
  for (const row of pageOpens) entry(row.client).pageOpens += row.count;
  return [...byClient.values()].sort(
    (a, b) => b.toolCalls + b.pageOpens - (a.toolCalls + a.pageOpens) || a.client.localeCompare(b.client),
  );
}

export function sumCounts(rows: readonly UsageCountRow[]): number {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

/** Overall `sum(cached) / sum(input)` across models; null when nothing was sent. */
export function overallCacheHitRate(rows: readonly ModelCacheHitRow[]): number | null {
  const input = rows.reduce((sum, row) => sum + row.input_tokens, 0);
  const cached = rows.reduce((sum, row) => sum + row.cached_tokens, 0);
  return input > 0 ? cached / input : null;
}

export function formatRate(rate: number | null): string {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
}
