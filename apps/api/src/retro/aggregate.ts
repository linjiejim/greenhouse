/**
 * Monthly retro (复盘) — the numbers. Aggregates only: counts and sums from
 * the usage counters, members' agent writes, Issues & requests and metering.
 * Never message content, never a member's name, never the title of anything
 * private (friction summaries are the normalized tool errors; feature request
 * titles are what members filed with the team).
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

/** The calendar month in `timeZone` that ended before `now` (the cron's target). */
export function previousMonthIn(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === 'year')!.value);
  const month = Number(parts.find((part) => part.type === 'month')!.value);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  return monthKey(previous);
}

export interface CountRow {
  key: string;
  count: number;
}

export interface RetroAggregates {
  month: RetroMonth;
  modules: {
    page_opens: CountRow[];
    tool_calls: CountRow[];
    by_client: Array<{ client: string; page_opens: number; tool_calls: number }>;
  };
  agents: {
    writes: number;
    members: number;
    by_client: Array<{ client: string; writes: number; executed: number; failed: number; outcome_unknown: number }>;
  };
  frictions: {
    seen: number;
    new: number;
    top: Array<{ summary: string; tool: string | null; kind: string; occurrences: number; status: string }>;
  };
  requests: {
    submitted: number;
    by_status: Record<string, number>;
    top: Array<{ title: string; status: string; priority: string }>;
  };
  spend: {
    total_usd_micros: number;
    calls: number;
    unpriced_calls: number;
    by_service: Array<{ key: string; cost_usd_micros: number; calls: number }>;
    by_client: Array<{ key: string; cost_usd_micros: number; calls: number }>;
  };
}

const TOP = 10;
const SUMMARY_CHARS = 120;

function sumBy(rows: Array<{ key: string; client: string; count: number }>, pick: 'key' | 'client'): CountRow[] {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row[pick], (totals.get(row[pick]) ?? 0) + row.count);
  return [...totals.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function lastDay(month: RetroMonth): string {
  return new Date(Date.parse(month.end) - 1).toISOString().slice(0, 10);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export async function collectRetroAggregates(db: DatabaseProvider, month: RetroMonth): Promise<RetroAggregates> {
  const window = { from: month.start, to: month.end };
  const days = { from: month.start.slice(0, 10), to: lastDay(month) };
  const spendQuery = { since: month.start, until: month.end };
  const [
    pages,
    tools,
    writes,
    members,
    frictions,
    frictionCounts,
    requests,
    requestCounts,
    totals,
    byService,
    byClient,
  ] = await Promise.all([
    db.usageCounters.summarize('page_open', days),
    db.usageCounters.summarize('tool_call', days),
    db.activity.agentWriteTotals(window),
    db.activity.agentWriteMembers(window),
    db.toolFrictions.listSeenBetween({ ...window, limit: TOP }),
    db.toolFrictions.countBetween(window),
    db.featureRequests.listCreatedBetween({ ...window, limit: TOP }),
    db.featureRequests.countCreatedBetweenByStatus(window),
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
    { client: string; writes: number; executed: number; failed: number; outcome_unknown: number }
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

  return {
    month,
    modules: { page_opens: sumBy(pages, 'key'), tool_calls: sumBy(tools, 'key'), by_client: clients },
    agents: {
      writes: writes.reduce((sum, row) => sum + row.writes, 0),
      members,
      by_client: [...agentClients.values()].sort((a, b) => b.writes - a.writes || a.client.localeCompare(b.client)),
    },
    frictions: {
      seen: frictionCounts.seen,
      new: frictionCounts.new,
      top: frictions.map((row) => ({
        summary: clip(row.summary, SUMMARY_CHARS),
        tool: row.tool_id,
        kind: row.kind,
        occurrences: row.occurrence_count,
        status: row.status,
      })),
    },
    requests: {
      submitted: Object.values(requestCounts).reduce((sum, count) => sum + count, 0),
      by_status: requestCounts,
      top: requests.map((row) => ({
        title: clip(row.title, SUMMARY_CHARS),
        status: row.status,
        priority: row.priority,
      })),
    },
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
