/** Usage section rules (React-free, tested): module and client totals from the daily counters. */

export interface UsageCountRow {
  key: string;
  client: string;
  count: number;
}
export interface ModelCacheRow {
  model: string;
  calls: number;
  input_tokens: number;
  cached_tokens: number;
  hit_rate: number | null;
}
export interface ModuleUsageReport {
  days: number;
  from: string;
  to: string;
  tool_calls: UsageCountRow[];
  page_opens: UsageCountRow[];
  cache_by_model: ModelCacheRow[];
}
export interface UsageSummary {
  by_profile: {
    profile_id: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    avg_duration_ms: number;
  }[];
  by_caller: { caller: string; calls: number; input_tokens: number; output_tokens: number }[];
  total: {
    total_calls: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cached_tokens: number;
    total_reasoning_tokens: number;
  };
}
export interface UserUsage {
  user_id: string;
  nickname: string;
  role: string;
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

export const USAGE_DAYS = [7, 30, 90] as const;
export type UsageDays = (typeof USAGE_DAYS)[number];

export interface KeyTotal {
  key: string;
  total: number;
  clients: { client: string; count: number }[];
}

/** Per key, its clients (largest first) and total; keys largest first. */
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

export function totalsByClient(
  toolCalls: readonly UsageCountRow[],
  pageOpens: readonly UsageCountRow[],
): ClientTotal[] {
  const byClient = new Map<string, ClientTotal>();
  const entry = (client: string) => {
    const found = byClient.get(client) ?? { client, toolCalls: 0, pageOpens: 0 };
    byClient.set(client, found);
    return found;
  };
  for (const row of toolCalls) entry(row.client).toolCalls += row.count;
  for (const row of pageOpens) entry(row.client).pageOpens += row.count;
  return [...byClient.values()].sort(
    (a, b) => b.toolCalls + b.pageOpens - (a.toolCalls + a.pageOpens) || a.client.localeCompare(b.client),
  );
}

export const sumCounts = (rows: readonly UsageCountRow[]) => rows.reduce((sum, row) => sum + row.count, 0);

export function overallCacheHitRate(rows: readonly ModelCacheRow[]): number | null {
  const input = rows.reduce((sum, row) => sum + row.input_tokens, 0);
  const cached = rows.reduce((sum, row) => sum + row.cached_tokens, 0);
  return input > 0 ? cached / input : null;
}

export const formatRate = (rate: number | null) => (rate == null ? '—' : `${(rate * 100).toFixed(1)}%`);

/** Core page modules the counters name (`ext.<plugin>` and `admin.*` / `settings.*` keys are labelled elsewhere). */
export const CORE_MODULES = [
  'home',
  'chat',
  'knowledge',
  'projects',
  'tables',
  'automations',
  'tasks',
  'agents',
  'skillhub',
  'activity',
  'executions',
  'files',
] as const;
export const USAGE_CLIENTS = [
  'mcp',
  'agent_api',
  'web_chat',
  'browser',
  'mobile',
  'desktop',
  'feishu',
  'automation',
  'subagent',
  'web',
] as const;
