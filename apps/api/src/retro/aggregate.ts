export type { FrictionErrorClass } from './insight-utils.js';
export { frictionErrorClass, FRICTION_ERROR_CLASSES } from './insight-utils.js';
import { fromExtensions } from '../extensions/index.js';
/**
 * Monthly retro (复盘) — the numbers. Aggregates only: counts and sums from
 * the usage counters, members' agent writes, Issues & requests and metering.
 * Never message content, never a member's name, never the title of anything
 * private. Friction summaries are free text (a model's or an error's words can
 * name a document or a person), so they never leave this module: a friction is
 * published only as tool × kind × error class (a closed vocabulary) × counts.
 * Feature request titles are what members filed with the team.
 *
 * The month is a UTC calendar month — the period metering and usage counters
 * already use.
 */
import { getUtcMonthPeriod, type DatabaseProvider } from '@greenhouse/db';
export interface RetroMonth {
  /** `YYYY-MM`. */
  month: string;
  /** Inclusive start, exclusive end (ISO). */
  start: string;
  end: string;
}
export function retroMonth(month: string): RetroMonth | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const index = Number(match[2]);
  if (index < 1 || index > 12) return null;
  const period = getUtcMonthPeriod(new Date(Date.UTC(Number(match[1]), index - 1, 1)));
  return { month, start: period.start, end: period.end };
}
export function monthKey(at: Date): string {
  return at.toISOString().slice(0, 7);
}
/** The month the scheduled run targets lives with the schedule (a leaf module). */
export { previousMonthIn } from './schedule.js';
export interface CountRow {
  key: string;
  count: number;
}
export interface RetroAggregates {
  month: RetroMonth;
  modules: {
    page_opens: CountRow[];
    tool_calls: CountRow[];
    by_client: Array<{
      client: string;
      page_opens: number;
      tool_calls: number;
    }>;
  };
  agents: {
    writes: number;
    members: number;
    by_client: Array<{
      client: string;
      writes: number;
      executed: number;
      failed: number;
      outcome_unknown: number;
    }>;
  };
  frictions: {
    /** Active during the month: first seen before its end, last seen after its start. */
    active: number;
    new: number;
    /** Grouped by tool × kind × error class — no free text. */
    top: Array<{
      tool: string | null;
      kind: string;
      error_class: import('./insight-utils.js').FrictionErrorClass;
      frictions: number;
      occurrences: number;
    }>;
  };
  requests: {
    submitted: number;
    by_status: Record<string, number>;
    top: Array<{
      title: string;
      status: string;
      priority: string;
    }>;
  };
  spend: {
    total_usd_micros: number;
    calls: number;
    unpriced_calls: number;
    by_service: Array<{
      key: string;
      cost_usd_micros: number;
      calls: number;
    }>;
    by_client: Array<{
      key: string;
      cost_usd_micros: number;
      calls: number;
    }>;
  };
}
function sumBy(
  rows: Array<{
    key: string;
    client: string;
    count: number;
  }>,
  pick: 'key' | 'client',
): CountRow[] {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row[pick], (totals.get(row[pick]) ?? 0) + row.count);
  return [...totals.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
function lastDay(month: RetroMonth): string {
  return new Date(Date.parse(month.end) - 1).toISOString().slice(0, 10);
}
export async function collectRetroAggregates(db: DatabaseProvider, month: RetroMonth): Promise<RetroAggregates> {
  const window = { from: month.start, to: month.end };
  const days = { from: month.start.slice(0, 10), to: lastDay(month) };
  const spendQuery = { since: month.start, until: month.end };
  const [pages, tools, writes, members, totals, byService, byClient] = await Promise.all([
    db.usageCounters.summarize('page_open', days),
    db.usageCounters.summarize('tool_call', days),
    db.activity.agentWriteTotals(window),
    db.activity.agentWriteMembers(window),
    db.metering.spendTotals(spendQuery),
    db.metering.spendBy('service', spendQuery),
    db.metering.spendBy('client', spendQuery),
  ]);
  const clientPages = new Map(sumBy(pages, 'client').map((row) => [row.key, row.count]));
  const clientTools = new Map(sumBy(tools, 'client').map((row) => [row.key, row.count]));
  const clients = [...new Set([...clientPages.keys(), ...clientTools.keys()])]
    .map((client) => ({ client, page_opens: clientPages.get(client) ?? 0, tool_calls: clientTools.get(client) ?? 0 }))
    .sort((a, b) => b.page_opens + b.tool_calls - (a.page_opens + a.tool_calls) || a.client.localeCompare(b.client));
  const agentClients = new Map<
    string,
    {
      client: string;
      writes: number;
      executed: number;
      failed: number;
      outcome_unknown: number;
    }
  >();
  for (const row of writes) {
    const client = row.client_name?.trim() || 'Unknown agent';
    const entry = agentClients.get(client) ?? { client, writes: 0, executed: 0, failed: 0, outcome_unknown: 0 };
    entry.writes += row.writes;
    if (row.status === 'succeeded') entry.executed += row.writes;
    else if (row.status === 'interrupted') entry.outcome_unknown += row.writes;
    else if (row.status === 'failed' || row.status === 'canceled') entry.failed += row.writes;
    agentClients.set(client, entry);
  }
  const contributed = Object.assign(
    {},
    ...(await Promise.all(fromExtensions('summarySources').map((source) => source.load(db, window)))),
  ) as Partial<RetroAggregates>;
  return {
    month,
    modules: { page_opens: sumBy(pages, 'key'), tool_calls: sumBy(tools, 'key'), by_client: clients },
    agents: {
      writes: writes.reduce((sum, row) => sum + row.writes, 0),
      members,
      by_client: [...agentClients.values()].sort((a, b) => b.writes - a.writes || a.client.localeCompare(b.client)),
    },
    frictions: { active: 0, new: 0, top: [] },
    requests: { submitted: 0, by_status: {}, top: [] },
    ...contributed,
    spend: {
      total_usd_micros: totals.cost_usd_micros,
      calls: totals.calls,
      unpriced_calls: totals.unpriced_calls,
      by_service: byService.map((row) => ({ key: row.key, cost_usd_micros: row.cost_usd_micros, calls: row.calls })),
      by_client: byClient.map((row) => ({
        key: row.key || 'unknown',
        cost_usd_micros: row.cost_usd_micros,
        calls: row.calls,
      })),
    },
  };
}
