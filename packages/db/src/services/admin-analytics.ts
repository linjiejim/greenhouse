/**
 * Admin analytics service — read-only aggregate queries for super-admin tooling
 * (PostgreSQL).
 *
 * PRIVACY HARD LINE (enforced HERE, not by callers): every query in this file is
 * a fixed, whitelisted-column aggregate. It NEVER selects message content,
 * session titles (titles are LLM-generated from the conversation, i.e. content),
 * or the `llm_calls` input/output/system prompts. There is deliberately no
 * generic/raw-query method — a super-admin can see counts, tokens, timing and
 * error strings, but never what any user (internal OR external) actually said.
 * Keep it that way when extending this service.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';

// ─── Return shapes ───────────────────────────────────────

export interface UserActivityRow {
  user_id: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  user_messages: number;
  session_count: number;
  last_active: string | null;
}

export interface UserActivitySummary {
  active_1d: number;
  active_7d: number;
  active_30d: number;
  users: UserActivityRow[];
}

/** One (dimension-value, model) usage bucket — the tool prices + rolls these up. */
export interface UsageDimensionRow {
  key: string; // profile_id | caller | model (per the requested dimension)
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  duration_ms: number;
}

export interface SessionMetaRow {
  id: string;
  channel: string;
  app_id: string | null;
  user_id: string | null;
  profile_id: string;
  status: string;
  message_count: number;
  total_tokens: number;
  created_at: string;
  updated_at: string;
}

export interface ApiClientStatRow {
  app_id: string;
  app_name: string | null;
  status: string | null;
  channel: string | null;
  total_calls: number;
  error_calls: number;
  ext_user_count: number;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  first_seen: string | null;
  last_seen: string | null;
}

export interface ExtUserStatRow {
  ext_user_id: string;
  app_id: string;
  calls: number;
  error_calls: number;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  first_seen: string | null;
  last_seen: string | null;
}

export interface ExtDailyRow {
  day: string;
  active_ext_users: number;
  calls: number;
}

export interface ErrorStatRow {
  key: string;
  errors: number;
}

export interface LlmErrorRecent {
  id: string;
  session_id: string;
  model: string;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface ApiErrorRecent {
  app_id: string;
  endpoint: string;
  method: string;
  status_code: number | null;
  error: string | null;
  created_at: string;
}

export interface ErrorReport {
  llm_by_model: ErrorStatRow[];
  llm_recent: LlmErrorRecent[];
  api_by_endpoint: ErrorStatRow[];
  api_recent: ApiErrorRecent[];
}

export type UsageDimension = 'profile' | 'model' | 'caller';

// ─── Helpers ─────────────────────────────────────────────

const num = (v: unknown): number => Number(v ?? 0);
const rows = (r: unknown): any[] => r as any[];

/** `WHERE a AND b …`, or empty when there are no conditions. Fragments are
 *  parameterized by drizzle's sql template — safe from injection. */
function where(conds: ReturnType<typeof sql>[]): ReturnType<typeof sql> {
  return conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
}

// ─── Service ─────────────────────────────────────────────

export function createAdminAnalyticsService(db: Db) {
  const service = {
    /** Internal-user activity: rolling active-user counts + per-user aggregates. */
    async userActivity(opts: { since?: string } = {}): Promise<UserActivitySummary> {
      const now = Date.now();
      const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
      const d1 = iso(86_400_000);
      const d7 = iso(7 * 86_400_000);
      const d30 = iso(30 * 86_400_000);

      const activeRows = rows(
        await db.execute(sql`
          SELECT
            COUNT(DISTINCT user_id) FILTER (WHERE created_at >= ${d1}) AS a1,
            COUNT(DISTINCT user_id) FILTER (WHERE created_at >= ${d7}) AS a7,
            COUNT(DISTINCT user_id) FILTER (WHERE created_at >= ${d30}) AS a30
          FROM llm_usage WHERE user_id IS NOT NULL
        `),
      )[0];

      const sinceUsage = opts.since ? sql`AND created_at >= ${opts.since}` : sql``;
      const usageRows = rows(
        await db.execute(sql`
          SELECT user_id, COUNT(*) AS calls,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            MAX(created_at) AS last_active
          FROM llm_usage WHERE user_id IS NOT NULL ${sinceUsage}
          GROUP BY user_id
        `),
      );

      const sinceMsg = opts.since ? sql`AND m.created_at >= ${opts.since}` : sql``;
      const msgRows = rows(
        await db.execute(sql`
          SELECT s.user_id AS user_id,
            COUNT(*) FILTER (WHERE m.role = 'user') AS user_messages,
            COUNT(DISTINCT s.id) AS session_count
          FROM messages m JOIN sessions s ON m.session_id = s.id
          WHERE s.user_id IS NOT NULL ${sinceMsg}
          GROUP BY s.user_id
        `),
      );
      const msgMap = new Map(msgRows.map((r) => [r.user_id as string, r]));

      const users: UserActivityRow[] = usageRows
        .map((r) => {
          const m = msgMap.get(r.user_id as string);
          return {
            user_id: r.user_id as string,
            calls: num(r.calls),
            input_tokens: num(r.input_tokens),
            output_tokens: num(r.output_tokens),
            user_messages: num(m?.user_messages),
            session_count: num(m?.session_count),
            last_active: (r.last_active as string | null) ?? null,
          };
        })
        .sort((a, b) => b.calls - a.calls);

      return {
        active_1d: num(activeRows?.a1),
        active_7d: num(activeRows?.a7),
        active_30d: num(activeRows?.a30),
        users,
      };
    },

    /**
     * Usage aggregated at (app_id, model) granularity — for pricing external-app
     * cost. `api_audit_log` has no model column, so accurate cost comes from
     * `llm_usage` joined to the app's sessions. `key` is the app_id.
     */
    async usageByApp(opts: { since?: string } = {}): Promise<UsageDimensionRow[]> {
      const since = opts.since ? sql`AND u.created_at >= ${opts.since}` : sql``;
      const result = rows(
        await db.execute(sql`
          SELECT s.app_id AS key, u.model AS model,
            COUNT(*) AS calls,
            COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
            COALESCE(SUM(u.cached_tokens), 0) AS cached_tokens,
            COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
            COALESCE(SUM(u.duration_ms), 0) AS duration_ms
          FROM llm_usage u JOIN sessions s ON u.session_id = s.id
          WHERE s.app_id IS NOT NULL ${since}
          GROUP BY s.app_id, u.model
        `),
      );
      return result.map((r) => ({
        key: (r.key as string) ?? '',
        model: (r.model as string) ?? '',
        calls: num(r.calls),
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        cached_tokens: num(r.cached_tokens),
        reasoning_tokens: num(r.reasoning_tokens),
        duration_ms: num(r.duration_ms),
      }));
    },

    /**
     * Usage aggregated at (dimension-value, model) granularity so the caller can
     * price each model bucket and roll up to the dimension. `dimension` selects a
     * FIXED whitelisted column — never raw input.
     */
    async usageByDimension(opts: { dimension: UsageDimension; since?: string }): Promise<UsageDimensionRow[]> {
      const dimCol =
        opts.dimension === 'profile' ? sql`profile_id` : opts.dimension === 'caller' ? sql`caller` : sql`model`;
      const since = opts.since ? sql`WHERE created_at >= ${opts.since}` : sql``;
      const result = rows(
        await db.execute(sql`
          SELECT ${dimCol} AS key, model,
            COUNT(*) AS calls,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
            COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
            COALESCE(SUM(duration_ms), 0) AS duration_ms
          FROM llm_usage ${since}
          GROUP BY ${dimCol}, model
        `),
      );
      return result.map((r) => ({
        key: (r.key as string) ?? '',
        model: (r.model as string) ?? '',
        calls: num(r.calls),
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        cached_tokens: num(r.cached_tokens),
        reasoning_tokens: num(r.reasoning_tokens),
        duration_ms: num(r.duration_ms),
      }));
    },

    /** Session METADATA only — never the title or any message content. */
    async listSessions(opts: {
      channel?: string;
      appId?: string;
      extUserId?: string;
      userId?: string;
      since?: string;
      limit?: number;
      offset?: number;
    }): Promise<SessionMetaRow[]> {
      const conds: ReturnType<typeof sql>[] = [];
      if (opts.channel) conds.push(sql`s.channel = ${opts.channel}`);
      if (opts.appId) conds.push(sql`s.app_id = ${opts.appId}`);
      if (opts.userId) conds.push(sql`s.user_id = ${opts.userId}`);
      if (opts.since) conds.push(sql`s.created_at >= ${opts.since}`);
      if (opts.extUserId) {
        conds.push(
          sql`EXISTS (SELECT 1 FROM api_audit_log a WHERE a.session_id = s.id AND a.ext_user_id = ${opts.extUserId})`,
        );
      }
      const limit = Math.min(opts.limit ?? 50, 500);
      const offset = opts.offset ?? 0;
      const result = rows(
        await db.execute(sql`
          SELECT s.id, s.channel, s.app_id, s.user_id, s.profile_id, s.status,
            s.created_at, s.updated_at,
            COUNT(m.id) AS message_count,
            COALESCE(SUM(COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0)), 0) AS total_tokens
          FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
          ${where(conds)}
          GROUP BY s.id
          ORDER BY s.updated_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `),
      );
      return result.map((r) => ({
        id: r.id as string,
        channel: r.channel as string,
        app_id: (r.app_id as string | null) ?? null,
        user_id: (r.user_id as string | null) ?? null,
        profile_id: r.profile_id as string,
        status: r.status as string,
        message_count: num(r.message_count),
        total_tokens: num(r.total_tokens),
        created_at: r.created_at as string,
        updated_at: r.updated_at as string,
      }));
    },

    /** Per external-app rollup from the API audit log, enriched with client meta. */
    async apiClientStats(opts: { since?: string } = {}): Promise<ApiClientStatRow[]> {
      const since = opts.since ? sql`WHERE a.created_at >= ${opts.since}` : sql``;
      const result = rows(
        await db.execute(sql`
          SELECT a.app_id,
            c.app_name, c.status, c.channel,
            COUNT(*) AS total_calls,
            COUNT(*) FILTER (WHERE a.status_code >= 400 OR a.error IS NOT NULL) AS error_calls,
            COUNT(DISTINCT a.ext_user_id) AS ext_user_count,
            COUNT(DISTINCT a.session_id) AS session_count,
            COALESCE(SUM(COALESCE(a.input_tokens, 0)), 0) AS input_tokens,
            COALESCE(SUM(COALESCE(a.output_tokens, 0)), 0) AS output_tokens,
            MIN(a.created_at) AS first_seen, MAX(a.created_at) AS last_seen
          FROM api_audit_log a
          LEFT JOIN api_clients c ON c.app_id = a.app_id
          ${since}
          GROUP BY a.app_id, c.app_name, c.status, c.channel
          ORDER BY total_calls DESC
        `),
      );
      return result.map((r) => ({
        app_id: r.app_id as string,
        app_name: (r.app_name as string | null) ?? null,
        status: (r.status as string | null) ?? null,
        channel: (r.channel as string | null) ?? null,
        total_calls: num(r.total_calls),
        error_calls: num(r.error_calls),
        ext_user_count: num(r.ext_user_count),
        session_count: num(r.session_count),
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        first_seen: (r.first_seen as string | null) ?? null,
        last_seen: (r.last_seen as string | null) ?? null,
      }));
    },

    /** Top external users by call volume, per (ext_user_id, app_id). */
    async extUserStats(opts: { appId?: string; since?: string; limit?: number } = {}): Promise<ExtUserStatRow[]> {
      const conds: ReturnType<typeof sql>[] = [sql`ext_user_id IS NOT NULL`];
      if (opts.appId) conds.push(sql`app_id = ${opts.appId}`);
      if (opts.since) conds.push(sql`created_at >= ${opts.since}`);
      const limit = Math.min(opts.limit ?? 50, 500);
      const result = rows(
        await db.execute(sql`
          SELECT ext_user_id, app_id,
            COUNT(*) AS calls,
            COUNT(*) FILTER (WHERE status_code >= 400 OR error IS NOT NULL) AS error_calls,
            COUNT(DISTINCT session_id) AS session_count,
            COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS input_tokens,
            COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS output_tokens,
            MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
          FROM api_audit_log
          ${where(conds)}
          GROUP BY ext_user_id, app_id
          ORDER BY calls DESC
          LIMIT ${limit}
        `),
      );
      return result.map((r) => ({
        ext_user_id: r.ext_user_id as string,
        app_id: r.app_id as string,
        calls: num(r.calls),
        error_calls: num(r.error_calls),
        session_count: num(r.session_count),
        input_tokens: num(r.input_tokens),
        output_tokens: num(r.output_tokens),
        first_seen: (r.first_seen as string | null) ?? null,
        last_seen: (r.last_seen as string | null) ?? null,
      }));
    },

    /** Per-day external activity (DAU-style): distinct ext users + call count. */
    async extActivityDaily(opts: { appId?: string; since?: string } = {}): Promise<ExtDailyRow[]> {
      const conds: ReturnType<typeof sql>[] = [sql`ext_user_id IS NOT NULL`];
      if (opts.appId) conds.push(sql`app_id = ${opts.appId}`);
      if (opts.since) conds.push(sql`created_at >= ${opts.since}`);
      const result = rows(
        await db.execute(sql`
          SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COUNT(DISTINCT ext_user_id) AS active_ext_users,
            COUNT(*) AS calls
          FROM api_audit_log
          ${where(conds)}
          GROUP BY day ORDER BY day
        `),
      );
      return result.map((r) => ({
        day: r.day as string,
        active_ext_users: num(r.active_ext_users),
        calls: num(r.calls),
      }));
    },

    /**
     * Error report. From `llm_calls` (status='error') and the API audit log
     * (4xx/5xx or a non-null error). Selects the error STRING and identifiers
     * only — never input/output/system prompts.
     */
    async errorStats(opts: { since?: string; appId?: string; limit?: number } = {}): Promise<ErrorReport> {
      const limit = Math.min(opts.limit ?? 20, 200);
      const sinceLlm = opts.since ? sql`AND created_at >= ${opts.since}` : sql``;

      const llmByModel = rows(
        await db.execute(sql`
          SELECT model AS key, COUNT(*) AS errors
          FROM llm_calls WHERE status = 'error' ${sinceLlm}
          GROUP BY model ORDER BY errors DESC
        `),
      ).map((r) => ({ key: (r.key as string) ?? '', errors: num(r.errors) }));

      const llmRecent = rows(
        await db.execute(sql`
          SELECT id, session_id, model, error, duration_ms, created_at
          FROM llm_calls WHERE status = 'error' ${sinceLlm}
          ORDER BY created_at DESC LIMIT ${limit}
        `),
      ).map((r) => ({
        id: r.id as string,
        session_id: r.session_id as string,
        model: r.model as string,
        error: (r.error as string | null) ?? null,
        duration_ms: r.duration_ms != null ? num(r.duration_ms) : null,
        created_at: r.created_at as string,
      }));

      const apiConds: ReturnType<typeof sql>[] = [sql`(status_code >= 400 OR error IS NOT NULL)`];
      if (opts.appId) apiConds.push(sql`app_id = ${opts.appId}`);
      if (opts.since) apiConds.push(sql`created_at >= ${opts.since}`);

      const apiByEndpoint = rows(
        await db.execute(sql`
          SELECT app_id || ' ' || endpoint AS key, COUNT(*) AS errors
          FROM api_audit_log ${where(apiConds)}
          GROUP BY app_id, endpoint ORDER BY errors DESC
        `),
      ).map((r) => ({ key: (r.key as string) ?? '', errors: num(r.errors) }));

      const apiRecent = rows(
        await db.execute(sql`
          SELECT app_id, endpoint, method, status_code, error, created_at
          FROM api_audit_log ${where(apiConds)}
          ORDER BY created_at DESC LIMIT ${limit}
        `),
      ).map((r) => ({
        app_id: r.app_id as string,
        endpoint: r.endpoint as string,
        method: r.method as string,
        status_code: r.status_code != null ? num(r.status_code) : null,
        error: (r.error as string | null) ?? null,
        created_at: r.created_at as string,
      }));

      return { llm_by_model: llmByModel, llm_recent: llmRecent, api_by_endpoint: apiByEndpoint, api_recent: apiRecent };
    },
  };
  return service;
}

export type AdminAnalyticsService = ReturnType<typeof createAdminAnalyticsService>;
