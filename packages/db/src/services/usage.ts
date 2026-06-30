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
        SELECT id, profile_id, caller, session_id, model,
               input_tokens, output_tokens, cached_tokens,
               reasoning_tokens, duration_ms, created_at
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

    /** Count today's user messages (for daily quota). */
    async countTodayMessages(userId: string): Promise<number> {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const result = await db.execute(sql`
        SELECT COUNT(*) as cnt FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE s.user_id = ${userId} AND m.role = 'user' AND m.created_at >= ${todayStart}
      `);
      return Number((result as any[])[0]?.cnt ?? 0);
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
