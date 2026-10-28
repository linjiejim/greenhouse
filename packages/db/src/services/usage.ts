/**
 * Usage service — model-call facts (`usage_events` of kind `model`) and their
 * aggregate stats. Service facts are written by `metering`, `audit` rows by
 * `llmCalls`; neither counts as a model call here.
 */

import { sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { ModelCacheHitRow } from '@greenhouse/types/usage';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { usageEvents } from '../schema/index.js';

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
  /** USD micros; null/omitted = unpriced (counted as zero). */
  cost_usd_micros?: number | null;
  /** Metering client (`@greenhouse/types/metering`). */
  client?: string | null;
  /** OAuth client of the member's agent when the call came over MCP. */
  oauth_client_id?: string | null;
  /** Metered service: `llm` / `vision`. */
  service?: string | null;
  /** The price this call was settled at (source + rates); null = unpriced. */
  price_applied?: Readonly<Record<string, unknown>> | null;
  /** The model gateway key the call came through. */
  gateway_key_id?: string | null;
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

function resultRows<T>(result: unknown): T[] {
  return result as T[];
}

export function createUsageService(db: Db) {
  const service = {
    /** Record a single LLM call. */
    async record(usage: UsageRecord): Promise<void> {
      await db.insert(usageEvents).values({
        id: newId('usageEvent'),
        kind: 'model',
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
        cost_usd_micros: usage.cost_usd_micros ?? null,
        client: usage.client ?? null,
        oauth_client_id: usage.oauth_client_id ?? null,
        service: usage.service ?? null,
        price_applied: usage.price_applied ? { ...usage.price_applied } : null,
        gateway_key_id: usage.gateway_key_id ?? null,
        created_at: nowIso(),
      });
    },

    /** Aggregate stats grouped by profile. */
    async getStatsByProfile(opts?: { since?: string }): Promise<UsageStats[]> {
      const conditions = opts?.since ? sql`AND created_at >= ${opts.since}` : sql``;

      const result = await db.execute(sql`
        SELECT profile_id, COUNT(*) AS total_calls,
          SUM(input_tokens) AS total_input_tokens, SUM(output_tokens) AS total_output_tokens,
          SUM(cached_tokens) AS total_cached_tokens, SUM(reasoning_tokens) AS total_reasoning_tokens,
          SUM(duration_ms) AS total_duration_ms, AVG(duration_ms) AS avg_duration_ms,
          MAX(created_at) AS last_used_at
        FROM usage_events WHERE kind = 'model' ${conditions}
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
        FROM usage_events WHERE kind = 'model' AND profile_id = ${profileId} ${sinceClause}
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
      const where = opts?.since ? sql`AND created_at >= ${opts.since}` : sql``;
      const result = await db.execute(sql`
        SELECT caller, COUNT(*) AS total_calls,
          SUM(input_tokens) AS total_input_tokens, SUM(output_tokens) AS total_output_tokens,
          SUM(cached_tokens) AS total_cached_tokens, SUM(reasoning_tokens) AS total_reasoning_tokens,
          SUM(duration_ms) AS total_duration_ms
        FROM usage_events WHERE kind = 'model' ${where}
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
    ): Promise<Array<UsageRecord & { id: string; created_at: string }>> {
      const where = profileId ? sql`AND profile_id = ${profileId}` : sql``;
      const result = await db.execute(sql`
        SELECT id, profile_id, caller, session_id, user_id, model,
               input_tokens, output_tokens, cached_tokens,
               reasoning_tokens, duration_ms, budget_idempotency_key, created_at
        FROM usage_events WHERE kind = 'model' ${where}
        ORDER BY created_at DESC, id DESC LIMIT ${limit}
      `);
      return (result as any[]).map((r) => ({
        ...r,
        id: String(r.id),
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
        cached_tokens: Number(r.cached_tokens),
        reasoning_tokens: Number(r.reasoning_tokens),
        duration_ms: r.duration_ms != null ? Number(r.duration_ms) : null,
      }));
    },

    /** Get global totals. */
    async getTotalStats(opts?: { since?: string }): Promise<TotalStats> {
      const where = opts?.since ? sql`AND created_at >= ${opts.since}` : sql``;
      const result = await db.execute(sql`
        SELECT COUNT(*) AS total_calls,
          COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
          COALESCE(SUM(cached_tokens), 0) AS total_cached_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS total_reasoning_tokens
        FROM usage_events WHERE kind = 'model' ${where}
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
     * Prompt-cache hit rate per model since an instant:
     * `sum(cached_tokens) / sum(input_tokens)`, null for a model with no input.
     */
    async getCacheHitByModel(opts: { since: string }): Promise<ModelCacheHitRow[]> {
      const rows = resultRows<{ model: string; calls: string; input_tokens: string; cached_tokens: string }>(
        await db.execute(sql`
          SELECT model, COUNT(*) AS calls,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(cached_tokens), 0) AS cached_tokens
          FROM usage_events WHERE kind = 'model' AND created_at >= ${opts.since}
          GROUP BY model ORDER BY SUM(input_tokens) DESC NULLS LAST, model
        `),
      );
      return rows.map((r) => {
        const input = Number(r.input_tokens);
        const cached = Number(r.cached_tokens);
        return {
          model: r.model,
          calls: Number(r.calls),
          input_tokens: input,
          cached_tokens: cached,
          hit_rate: input > 0 ? cached / input : null,
        };
      });
    },
  };
  return service;
}

export type UsageService = ReturnType<typeof createUsageService>;
