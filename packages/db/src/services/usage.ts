/**
 * Usage service — LLM usage tracking and aggregate stats (PostgreSQL).
 */

import { sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { llmUsage } from '../schema/index.js';

export interface UsageRecord {
  profile_id: string;
  caller: string; // 'chat' | 'compiler' | 'judge' | 'api'
  session_id?: string;
  user_id?: string; // authenticated user who triggered this call
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  duration_ms?: number;
  /** Links budget-aware calls to their reservation; null/omitted = legacy usage. */
  budget_idempotency_key?: string;
}

export interface UsageStats {
  profile_id: string;
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_reasoning_tokens: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  last_used_at: string | null;
}

export interface CallerStats {
  caller: string;
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_reasoning_tokens: number;
  total_duration_ms: number;
}

export interface TotalStats {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_reasoning_tokens: number;
}

export interface CostValueUsageMetric {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_reasoning_tokens: number;
  total_tokens: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  /** No provider price catalog exists, so text-token dollars are deliberately absent. */
  cost_estimate_usd: null;
}

export interface CostValueAgentMetric extends CostValueUsageMetric {
  profile_id: string;
  agent_id: string;
  agent_version: number | null;
  name: string;
  owner_user_id: string | null;
  /** Settled/expired USD budget ledger entries, attributed through the usage reservation key. */
  actual_usd_micros: number;
}

export interface CostValueUserMetric extends CostValueUsageMetric {
  user_id: string;
  nickname: string | null;
  email: string | null;
  role: string | null;
  actual_usd_micros: number;
}

export interface CostValueRuntimeMetric {
  kind: string;
  total_runs: number;
  terminal_runs: number;
  succeeded_runs: number;
  failed_runs: number;
  llm_calls: number;
  llm_tokens: number;
  step_requests: number;
  step_tokens: number;
  actual_usd_micros: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  /** succeeded / terminal; null means no terminal run exists in the period. */
  effective_completion_rate: number | null;
}

export interface CostValueRuntimeRunMetric {
  id: string;
  kind: string;
  source_kind: string;
  source_id: string;
  owner_user_id: string;
  status: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number;
  llm_calls: number;
  llm_tokens: number;
  step_requests: number;
  step_tokens: number;
  actual_usd_micros: number;
}

export interface CostValueBudgetBalance {
  account_id: string;
  scope_type: string;
  scope_id: string;
  unit: string;
  status: string;
  period_start: string;
  period_end: string;
  limit_units: number;
  reserved_units: number;
  spent_units: number;
  available_units: number;
  exceeded: boolean;
}

export interface CostValueReport {
  period: { since: string; until: string };
  accounting: {
    token_cost_estimate: null;
    token_cost_estimate_reason: 'provider_prices_unavailable';
    usd_source: 'usage_budget_ledger';
  };
  organization: CostValueUsageMetric & {
    runtime_runs: number;
    runtime_terminal_runs: number;
    runtime_succeeded_runs: number;
    effective_completion_rate: number | null;
    actual_usd_micros: number;
  };
  agents: CostValueAgentMetric[];
  users: CostValueUserMetric[];
  runtime_by_kind: CostValueRuntimeMetric[];
  recent_runs: CostValueRuntimeRunMetric[];
  budgets: CostValueBudgetBalance[];
}

export interface CostValueReportOptions {
  since: string;
  until: string;
  run_limit?: number;
}

interface UsageAggregateRow {
  total_calls: string | number;
  total_input_tokens: string | number;
  total_output_tokens: string | number;
  total_cached_tokens: string | number;
  total_reasoning_tokens: string | number;
  total_duration_ms: string | number;
  avg_duration_ms: string | number;
}

function usageMetric(row: UsageAggregateRow): CostValueUsageMetric {
  const input = Number(row.total_input_tokens ?? 0);
  const output = Number(row.total_output_tokens ?? 0);
  return {
    total_calls: Number(row.total_calls ?? 0),
    total_input_tokens: input,
    total_output_tokens: output,
    total_cached_tokens: Number(row.total_cached_tokens ?? 0),
    total_reasoning_tokens: Number(row.total_reasoning_tokens ?? 0),
    total_tokens: input + output,
    total_duration_ms: Number(row.total_duration_ms ?? 0),
    avg_duration_ms: Math.round(Number(row.avg_duration_ms ?? 0)),
    cost_estimate_usd: null,
  };
}

function resultRows<T>(result: unknown): T[] {
  return result as T[];
}

export function createUsageService(db: Db) {
  const service = {
    /** Record a single LLM call. */
    async record(usage: UsageRecord): Promise<void> {
      await db.insert(llmUsage).values({
        profile_id: usage.profile_id,
        caller: usage.caller,
        session_id: usage.session_id ?? null,
        user_id: usage.user_id ?? null,
        model: usage.model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cached_tokens: usage.cached_tokens ?? 0,
        reasoning_tokens: usage.reasoning_tokens ?? 0,
        duration_ms: usage.duration_ms ?? null,
        budget_idempotency_key: usage.budget_idempotency_key ?? null,
        created_at: nowIso(),
      });
    },

    /** Aggregate stats grouped by profile. */
    async getStatsByProfile(opts?: { since?: string }): Promise<UsageStats[]> {
      const conditions = opts?.since ? sql`WHERE created_at >= ${opts.since}` : sql``;

      const result = await db.execute(sql`
        SELECT profile_id, COUNT(*) AS total_calls,
          SUM(input_tokens) AS total_input_tokens, SUM(output_tokens) AS total_output_tokens,
          SUM(cached_tokens) AS total_cached_tokens, SUM(reasoning_tokens) AS total_reasoning_tokens,
          SUM(duration_ms) AS total_duration_ms, AVG(duration_ms) AS avg_duration_ms,
          MAX(created_at) AS last_used_at
        FROM llm_usage ${conditions}
        GROUP BY profile_id ORDER BY total_calls DESC
      `);
      return (result as any[]).map((r) => ({
        profile_id: r.profile_id,
        total_calls: Number(r.total_calls),
        total_input_tokens: Number(r.total_input_tokens),
        total_output_tokens: Number(r.total_output_tokens),
        total_cached_tokens: Number(r.total_cached_tokens),
        total_reasoning_tokens: Number(r.total_reasoning_tokens),
        total_duration_ms: Number(r.total_duration_ms),
        avg_duration_ms: Math.round(Number(r.avg_duration_ms) || 0),
        last_used_at: r.last_used_at,
      }));
    },

    /** Get stats for a single profile. */
    async getProfileStats(profileId: string, opts?: { since?: string }): Promise<UsageStats | null> {
      const sinceClause = opts?.since ? sql`AND created_at >= ${opts.since}` : sql``;
      const result = await db.execute(sql`
        SELECT profile_id, COUNT(*) AS total_calls,
          SUM(input_tokens) AS total_input_tokens, SUM(output_tokens) AS total_output_tokens,
          SUM(cached_tokens) AS total_cached_tokens, SUM(reasoning_tokens) AS total_reasoning_tokens,
          SUM(duration_ms) AS total_duration_ms, AVG(duration_ms) AS avg_duration_ms,
          MAX(created_at) AS last_used_at
        FROM llm_usage WHERE profile_id = ${profileId} ${sinceClause}
        GROUP BY profile_id
      `);
      const r = (result as any[])[0];
      if (!r || Number(r.total_calls) === 0) return null;
      return {
        profile_id: r.profile_id,
        total_calls: Number(r.total_calls),
        total_input_tokens: Number(r.total_input_tokens),
        total_output_tokens: Number(r.total_output_tokens),
        total_cached_tokens: Number(r.total_cached_tokens),
        total_reasoning_tokens: Number(r.total_reasoning_tokens),
        total_duration_ms: Number(r.total_duration_ms),
        avg_duration_ms: Math.round(Number(r.avg_duration_ms) || 0),
        last_used_at: r.last_used_at,
      };
    },

    /** Aggregate stats grouped by caller. */
    async getStatsByCaller(opts?: { since?: string }): Promise<CallerStats[]> {
      const where = opts?.since ? sql`WHERE created_at >= ${opts.since}` : sql``;
      const result = await db.execute(sql`
        SELECT caller, COUNT(*) AS total_calls,
          SUM(input_tokens) AS total_input_tokens, SUM(output_tokens) AS total_output_tokens,
          SUM(cached_tokens) AS total_cached_tokens, SUM(reasoning_tokens) AS total_reasoning_tokens,
          SUM(duration_ms) AS total_duration_ms
        FROM llm_usage ${where}
        GROUP BY caller ORDER BY total_calls DESC
      `);
      return (result as any[]).map((r) => ({
        caller: r.caller,
        total_calls: Number(r.total_calls),
        total_input_tokens: Number(r.total_input_tokens),
        total_output_tokens: Number(r.total_output_tokens),
        total_cached_tokens: Number(r.total_cached_tokens),
        total_reasoning_tokens: Number(r.total_reasoning_tokens),
        total_duration_ms: Number(r.total_duration_ms),
      }));
    },

    /** Get recent usage records, optionally filtered by profile. */
    async getRecentUsage(
      profileId?: string,
      limit = 20,
    ): Promise<Array<UsageRecord & { id: number; created_at: string }>> {
      const where = profileId ? sql`WHERE profile_id = ${profileId}` : sql``;
      const result = await db.execute(sql`
        SELECT id, profile_id, caller, session_id, user_id, model,
               input_tokens, output_tokens, cached_tokens,
               reasoning_tokens, duration_ms, budget_idempotency_key, created_at
        FROM llm_usage ${where}
        ORDER BY created_at DESC LIMIT ${limit}
      `);
      return (result as any[]).map((r) => ({
        ...r,
        id: Number(r.id),
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
        cached_tokens: Number(r.cached_tokens),
        reasoning_tokens: Number(r.reasoning_tokens),
        duration_ms: r.duration_ms != null ? Number(r.duration_ms) : null,
      }));
    },

    /** Get global totals. */
    async getTotalStats(opts?: { since?: string }): Promise<TotalStats> {
      const where = opts?.since ? sql`WHERE created_at >= ${opts.since}` : sql``;
      const result = await db.execute(sql`
        SELECT COUNT(*) AS total_calls,
          COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
          COALESCE(SUM(cached_tokens), 0) AS total_cached_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS total_reasoning_tokens
        FROM llm_usage ${where}
      `);
      const r = (result as any[])[0];
      return {
        total_calls: Number(r.total_calls),
        total_input_tokens: Number(r.total_input_tokens),
        total_output_tokens: Number(r.total_output_tokens),
        total_cached_tokens: Number(r.total_cached_tokens),
        total_reasoning_tokens: Number(r.total_reasoning_tokens),
      };
    },

    /**
     * Super-admin operating report over persisted usage, Runtime and budget facts.
     *
     * Text LLM prices are intentionally not inferred from model ids: the model
     * registry has provider fallback chains but no versioned price catalog.
     * Dollar values therefore come only from actual `usd_micros` ledger deltas.
     */
    async getCostValueReport(options: CostValueReportOptions): Promise<CostValueReport> {
      const runLimit = Math.max(1, Math.min(100, Math.trunc(options.run_limit ?? 25)));
      const since = options.since;
      const until = options.until;

      const totalRows = resultRows<UsageAggregateRow>(
        await db.execute(sql`
          SELECT COUNT(*) AS total_calls,
            COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
            COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
            COALESCE(SUM(cached_tokens), 0) AS total_cached_tokens,
            COALESCE(SUM(reasoning_tokens), 0) AS total_reasoning_tokens,
            COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
            COALESCE(AVG(duration_ms), 0) AS avg_duration_ms
          FROM llm_usage
          WHERE created_at >= ${since} AND created_at < ${until}
        `),
      );

      type AgentUsageRow = UsageAggregateRow & { profile_id: string };
      const agentRows = resultRows<AgentUsageRow>(
        await db.execute(sql`
          SELECT profile_id, COUNT(*) AS total_calls,
            COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
            COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
            COALESCE(SUM(cached_tokens), 0) AS total_cached_tokens,
            COALESCE(SUM(reasoning_tokens), 0) AS total_reasoning_tokens,
            COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
            COALESCE(AVG(duration_ms), 0) AS avg_duration_ms
          FROM llm_usage
          WHERE created_at >= ${since} AND created_at < ${until}
          GROUP BY profile_id
          ORDER BY total_calls DESC, profile_id ASC
        `),
      );

      type AgentAssetRow = { id: number; name: string; user_id: string };
      const agentAssetRows = resultRows<AgentAssetRow>(
        await db.execute(sql`SELECT id, name, user_id FROM custom_profiles`),
      );
      const agentAssets = new Map(agentAssetRows.map((row) => [Number(row.id), row]));

      type AgentUsdRow = { profile_id: string; actual_usd_micros: string | number };
      const agentUsdRows = resultRows<AgentUsdRow>(
        await db.execute(sql`
          WITH budget_profiles AS (
            SELECT budget_idempotency_key, MIN(profile_id) AS profile_id
            FROM llm_usage
            WHERE budget_idempotency_key IS NOT NULL
            GROUP BY budget_idempotency_key
            HAVING COUNT(DISTINCT profile_id) = 1
          )
          SELECT bp.profile_id, COALESCE(SUM(ledger.delta_spent_units), 0) AS actual_usd_micros
          FROM usage_budget_ledger ledger
          JOIN usage_budget_reservations reservation ON reservation.id = ledger.reservation_id
          JOIN usage_budget_accounts account ON account.id = ledger.account_id
          JOIN budget_profiles bp ON bp.budget_idempotency_key = reservation.idempotency_key
          WHERE account.scope_type = 'user' AND account.unit = 'usd_micros'
            AND ledger.created_at >= ${since} AND ledger.created_at < ${until}
          GROUP BY bp.profile_id
        `),
      );
      const usdByProfile = new Map(agentUsdRows.map((row) => [row.profile_id, Number(row.actual_usd_micros)]));

      const customReference = /^custom:(\d+)(?:@(\d+))?$/;
      const agents: CostValueAgentMetric[] = agentRows.map((row) => {
        const match = customReference.exec(row.profile_id);
        const customId = match ? Number(match[1]) : null;
        const asset = customId == null ? undefined : agentAssets.get(customId);
        return {
          ...usageMetric(row),
          profile_id: row.profile_id,
          agent_id: customId == null ? row.profile_id : `custom:${customId}`,
          agent_version: match?.[2] ? Number(match[2]) : null,
          name: asset?.name ?? row.profile_id,
          owner_user_id: asset?.user_id ?? null,
          actual_usd_micros: usdByProfile.get(row.profile_id) ?? 0,
        };
      });

      type UserUsageRow = UsageAggregateRow & {
        user_id: string;
        nickname: string | null;
        email: string | null;
        role: string | null;
      };
      const userRows = resultRows<UserUsageRow>(
        await db.execute(sql`
          SELECT usage.user_id, users.nickname, users.email, users.role,
            COUNT(*) AS total_calls,
            COALESCE(SUM(usage.input_tokens), 0) AS total_input_tokens,
            COALESCE(SUM(usage.output_tokens), 0) AS total_output_tokens,
            COALESCE(SUM(usage.cached_tokens), 0) AS total_cached_tokens,
            COALESCE(SUM(usage.reasoning_tokens), 0) AS total_reasoning_tokens,
            COALESCE(SUM(usage.duration_ms), 0) AS total_duration_ms,
            COALESCE(AVG(usage.duration_ms), 0) AS avg_duration_ms
          FROM llm_usage usage
          LEFT JOIN users ON users.id = usage.user_id
          WHERE usage.user_id IS NOT NULL
            AND usage.created_at >= ${since} AND usage.created_at < ${until}
          GROUP BY usage.user_id, users.nickname, users.email, users.role
          ORDER BY total_calls DESC, usage.user_id ASC
        `),
      );

      type UserUsdRow = { user_id: string; actual_usd_micros: string | number };
      const userUsdRows = resultRows<UserUsdRow>(
        await db.execute(sql`
          SELECT account.scope_id AS user_id,
            COALESCE(SUM(ledger.delta_spent_units), 0) AS actual_usd_micros
          FROM usage_budget_ledger ledger
          JOIN usage_budget_accounts account ON account.id = ledger.account_id
          WHERE account.scope_type = 'user' AND account.unit = 'usd_micros'
            AND ledger.created_at >= ${since} AND ledger.created_at < ${until}
          GROUP BY account.scope_id
        `),
      );
      const usdByUser = new Map(userUsdRows.map((row) => [row.user_id, Number(row.actual_usd_micros)]));
      const users: CostValueUserMetric[] = userRows.map((row) => ({
        ...usageMetric(row),
        user_id: row.user_id,
        nickname: row.nickname,
        email: row.email,
        role: row.role,
        actual_usd_micros: usdByUser.get(row.user_id) ?? 0,
      }));

      type RuntimeKindRow = {
        kind: string;
        total_runs: string | number;
        terminal_runs: string | number;
        succeeded_runs: string | number;
        failed_runs: string | number;
        llm_calls: string | number;
        llm_tokens: string | number;
        step_requests: string | number;
        step_tokens: string | number;
        actual_usd_micros: string | number;
        total_duration_ms: string | number;
        avg_duration_ms: string | number;
      };
      const runtimeKindRows = resultRows<RuntimeKindRow>(
        await db.execute(sql`
          WITH reservation_run_keys AS (
            SELECT idempotency_key, MIN(run_id) AS run_id
            FROM usage_budget_reservations
            WHERE run_id IS NOT NULL
            GROUP BY idempotency_key
          ), linked_usage AS (
            SELECT keys.run_id, COUNT(usage.id) AS llm_calls,
              COALESCE(SUM(usage.input_tokens + usage.output_tokens), 0) AS llm_tokens
            FROM reservation_run_keys keys
            JOIN llm_usage usage ON usage.budget_idempotency_key = keys.idempotency_key
            GROUP BY keys.run_id
          ), step_usage AS (
            SELECT run_id, COALESCE(SUM(requests_used), 0) AS step_requests,
              COALESCE(SUM(tokens_used), 0) AS step_tokens
            FROM runtime_steps
            GROUP BY run_id
          ), run_usd AS (
            SELECT reservation.run_id,
              COALESCE(SUM(ledger.delta_spent_units), 0) AS actual_usd_micros
            FROM usage_budget_ledger ledger
            JOIN usage_budget_reservations reservation ON reservation.id = ledger.reservation_id
            JOIN usage_budget_accounts account ON account.id = ledger.account_id
            WHERE reservation.run_id IS NOT NULL
              AND account.scope_type = 'user' AND account.unit = 'usd_micros'
            GROUP BY reservation.run_id
          )
          SELECT run.kind, COUNT(*) AS total_runs,
            COUNT(*) FILTER (WHERE run.status IN ('succeeded', 'failed', 'canceled', 'interrupted')) AS terminal_runs,
            COUNT(*) FILTER (WHERE run.status = 'succeeded') AS succeeded_runs,
            COUNT(*) FILTER (WHERE run.status = 'failed') AS failed_runs,
            COALESCE(SUM(linked.llm_calls), 0) AS llm_calls,
            COALESCE(SUM(linked.llm_tokens), 0) AS llm_tokens,
            COALESCE(SUM(steps.step_requests), 0) AS step_requests,
            COALESCE(SUM(steps.step_tokens), 0) AS step_tokens,
            COALESCE(SUM(run_cost.actual_usd_micros), 0) AS actual_usd_micros,
            COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(run.ended_at, run.updated_at) - COALESCE(run.started_at, run.created_at))) * 1000), 0)
              AS total_duration_ms,
            COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(run.ended_at, run.updated_at) - COALESCE(run.started_at, run.created_at))) * 1000), 0)
              AS avg_duration_ms
          FROM runtime_runs run
          LEFT JOIN linked_usage linked ON linked.run_id = run.id
          LEFT JOIN step_usage steps ON steps.run_id = run.id
          LEFT JOIN run_usd run_cost ON run_cost.run_id = run.id
          WHERE run.created_at >= ${since} AND run.created_at < ${until}
          GROUP BY run.kind
          ORDER BY total_runs DESC, run.kind ASC
        `),
      );
      const runtimeByKind: CostValueRuntimeMetric[] = runtimeKindRows.map((row) => {
        const terminalRuns = Number(row.terminal_runs);
        const succeededRuns = Number(row.succeeded_runs);
        return {
          kind: row.kind,
          total_runs: Number(row.total_runs),
          terminal_runs: terminalRuns,
          succeeded_runs: succeededRuns,
          failed_runs: Number(row.failed_runs),
          llm_calls: Number(row.llm_calls),
          llm_tokens: Number(row.llm_tokens),
          step_requests: Number(row.step_requests),
          step_tokens: Number(row.step_tokens),
          actual_usd_micros: Number(row.actual_usd_micros),
          total_duration_ms: Math.round(Number(row.total_duration_ms)),
          avg_duration_ms: Math.round(Number(row.avg_duration_ms)),
          effective_completion_rate: terminalRuns > 0 ? succeededRuns / terminalRuns : null,
        };
      });

      type RuntimeRunRow = {
        id: string;
        kind: string;
        source_kind: string;
        source_id: string;
        owner_user_id: string;
        status: string;
        created_at: string;
        started_at: string | null;
        ended_at: string | null;
        duration_ms: string | number;
        llm_calls: string | number;
        llm_tokens: string | number;
        step_requests: string | number;
        step_tokens: string | number;
        actual_usd_micros: string | number;
      };
      const recentRunRows = resultRows<RuntimeRunRow>(
        await db.execute(sql`
          WITH reservation_run_keys AS (
            SELECT idempotency_key, MIN(run_id) AS run_id
            FROM usage_budget_reservations
            WHERE run_id IS NOT NULL
            GROUP BY idempotency_key
          ), linked_usage AS (
            SELECT keys.run_id, COUNT(usage.id) AS llm_calls,
              COALESCE(SUM(usage.input_tokens + usage.output_tokens), 0) AS llm_tokens
            FROM reservation_run_keys keys
            JOIN llm_usage usage ON usage.budget_idempotency_key = keys.idempotency_key
            GROUP BY keys.run_id
          ), step_usage AS (
            SELECT run_id, COALESCE(SUM(requests_used), 0) AS step_requests,
              COALESCE(SUM(tokens_used), 0) AS step_tokens
            FROM runtime_steps
            GROUP BY run_id
          ), run_usd AS (
            SELECT reservation.run_id,
              COALESCE(SUM(ledger.delta_spent_units), 0) AS actual_usd_micros
            FROM usage_budget_ledger ledger
            JOIN usage_budget_reservations reservation ON reservation.id = ledger.reservation_id
            JOIN usage_budget_accounts account ON account.id = ledger.account_id
            WHERE reservation.run_id IS NOT NULL
              AND account.scope_type = 'user' AND account.unit = 'usd_micros'
            GROUP BY reservation.run_id
          )
          SELECT run.id, run.kind, run.source_kind, run.source_id, run.owner_user_id,
            run.status, run.created_at, run.started_at, run.ended_at,
            COALESCE(EXTRACT(EPOCH FROM (COALESCE(run.ended_at, run.updated_at) - COALESCE(run.started_at, run.created_at))) * 1000, 0)
              AS duration_ms,
            COALESCE(linked.llm_calls, 0) AS llm_calls,
            COALESCE(linked.llm_tokens, 0) AS llm_tokens,
            COALESCE(steps.step_requests, 0) AS step_requests,
            COALESCE(steps.step_tokens, 0) AS step_tokens,
            COALESCE(run_cost.actual_usd_micros, 0) AS actual_usd_micros
          FROM runtime_runs run
          LEFT JOIN linked_usage linked ON linked.run_id = run.id
          LEFT JOIN step_usage steps ON steps.run_id = run.id
          LEFT JOIN run_usd run_cost ON run_cost.run_id = run.id
          WHERE run.created_at >= ${since} AND run.created_at < ${until}
          ORDER BY run.created_at DESC, run.id DESC
          LIMIT ${runLimit}
        `),
      );
      const recentRuns: CostValueRuntimeRunMetric[] = recentRunRows.map((row) => ({
        ...row,
        duration_ms: Math.round(Number(row.duration_ms)),
        llm_calls: Number(row.llm_calls),
        llm_tokens: Number(row.llm_tokens),
        step_requests: Number(row.step_requests),
        step_tokens: Number(row.step_tokens),
        actual_usd_micros: Number(row.actual_usd_micros),
      }));

      type BudgetRow = {
        id: string;
        scope_type: string;
        scope_id: string;
        unit: string;
        status: string;
        period_start: string;
        period_end: string;
        limit_units: string | number;
        reserved_units: string | number;
        spent_units: string | number;
      };
      const budgetRows = resultRows<BudgetRow>(
        await db.execute(sql`
          SELECT id, scope_type, scope_id, unit, status, period_start, period_end,
            limit_units, reserved_units, spent_units
          FROM usage_budget_accounts
          WHERE period_end > ${since} AND period_start < ${until}
          ORDER BY scope_type ASC, scope_id ASC, unit ASC
        `),
      );
      const budgets: CostValueBudgetBalance[] = budgetRows.map((row) => {
        const limit = Number(row.limit_units);
        const reserved = Number(row.reserved_units);
        const spent = Number(row.spent_units);
        return {
          account_id: row.id,
          scope_type: row.scope_type,
          scope_id: row.scope_id,
          unit: row.unit,
          status: row.status,
          period_start: row.period_start,
          period_end: row.period_end,
          limit_units: limit,
          reserved_units: reserved,
          spent_units: spent,
          available_units: Math.max(0, limit - reserved - spent),
          exceeded: reserved + spent > limit,
        };
      });

      type RuntimeTotalRow = {
        total_runs: string | number;
        terminal_runs: string | number;
        succeeded_runs: string | number;
      };
      const runtimeTotals = runtimeByKind.reduce<RuntimeTotalRow>(
        (sum, row) => ({
          total_runs: Number(sum.total_runs) + row.total_runs,
          terminal_runs: Number(sum.terminal_runs) + row.terminal_runs,
          succeeded_runs: Number(sum.succeeded_runs) + row.succeeded_runs,
        }),
        { total_runs: 0, terminal_runs: 0, succeeded_runs: 0 },
      );
      const organizationUsdRows = resultRows<{ actual_usd_micros: string | number }>(
        await db.execute(sql`
          SELECT COALESCE(SUM(ledger.delta_spent_units), 0) AS actual_usd_micros
          FROM usage_budget_ledger ledger
          JOIN usage_budget_accounts account ON account.id = ledger.account_id
          WHERE account.scope_type = 'organization' AND account.unit = 'usd_micros'
            AND ledger.created_at >= ${since} AND ledger.created_at < ${until}
        `),
      );
      const terminalRuns = Number(runtimeTotals.terminal_runs);
      const succeededRuns = Number(runtimeTotals.succeeded_runs);

      return {
        period: { since, until },
        accounting: {
          token_cost_estimate: null,
          token_cost_estimate_reason: 'provider_prices_unavailable',
          usd_source: 'usage_budget_ledger',
        },
        organization: {
          ...usageMetric(totalRows[0]!),
          runtime_runs: Number(runtimeTotals.total_runs),
          runtime_terminal_runs: terminalRuns,
          runtime_succeeded_runs: succeededRuns,
          effective_completion_rate: terminalRuns > 0 ? succeededRuns / terminalRuns : null,
          actual_usd_micros: Number(organizationUsdRows[0]?.actual_usd_micros ?? 0),
        },
        agents,
        users,
        runtime_by_kind: runtimeByKind,
        recent_runs: recentRuns,
        budgets,
      };
    },

    /** Sum this month's token usage (for monthly quota). */
    async sumMonthTokens(userId: string): Promise<number> {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const result = await db.execute(sql`
        SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total
        FROM llm_usage WHERE user_id = ${userId} AND created_at >= ${monthStart}
      `);
      return Number((result as any[])[0]?.total ?? 0);
    },
  };
  return service;
}

export type UsageService = ReturnType<typeof createUsageService>;
