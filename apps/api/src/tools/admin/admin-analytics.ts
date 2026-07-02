/**
 * Admin Analytics tool — super-admin-only, read-only data analysis.
 *
 * One tool, six actions, over the content-free `adminAnalytics` DB service:
 *   user_activity · usage_stats · sessions · api_clients · ext_users · errors
 *
 * PRIVACY: this tool can NEVER surface conversation content. The DB service only
 * returns counts/tokens/timing/error-strings and deliberately omits message
 * bodies, session titles, and llm_call input/output. Cost figures are ESTIMATES
 * from a static price table (see ./pricing.ts) — every money field is suffixed
 * `_usd_est` and results carry `cost_is_estimate: true`.
 *
 * THREE-LAYER role gate (defense in depth): (1) resolveUserTools subtracts
 * super-category tools from non-super allow-sets; (2) buildLazyServerTools skips
 * `requires.user: 'super'` tools for non-super callers; (3) execute() re-checks
 * the role below. It also declares no `surface`, so it is never proxy/MCP-exposed.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider, UsageDimensionRow } from '@greenhouse/db';
import { defineTool, type ToolMeta } from '../define.js';
import { estimateCostUsd } from './pricing.js';

const adminAnalyticsSchema = z.object({
  action: z
    .enum(['user_activity', 'usage_stats', 'sessions', 'api_clients', 'ext_users', 'errors'])
    .describe('Which analysis to run.'),
  period: z
    .enum(['today', '7d', '30d', 'all'])
    .optional()
    .describe('Time window (default 7d). "today" = since local midnight; "all" = no lower bound.'),
  group_by: z
    .enum(['profile', 'model', 'caller'])
    .optional()
    .describe('usage_stats only — aggregation dimension (default model).'),
  channel: z.string().optional().describe('sessions only — filter by channel (web/api/a2a/task/subagent/browser).'),
  app_id: z.string().optional().describe('External app id filter (sessions/api_clients/ext_users/errors).'),
  ext_user_id: z.string().optional().describe('sessions only — filter to one external user id.'),
  user_id: z.string().optional().describe('sessions only — filter to one internal user id.'),
  limit: z.number().min(1).max(500).optional().describe('Max rows (default 50; recent-error lists default 20).'),
  offset: z.number().min(0).optional().describe('sessions only — pagination offset.'),
});

type AdminAnalyticsInput = z.infer<typeof adminAnalyticsSchema>;

export interface AdminAnalyticsContext {
  userId: string;
  userRole: string;
}

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'admin_analytics',
  name: 'Admin Analytics',
  brief: 'Super-admin usage & activity analytics',
  description: `Super-admin-only, READ-ONLY analytics over usage, activity and external-API traffic. Actions:
- user_activity — internal-user activity: rolling active-user counts (1d/7d/30d) + per-user calls, tokens, message count, last active.
- usage_stats — LLM usage aggregated by group_by (profile|model|caller), with estimated USD cost.
- sessions — session METADATA search (filter by channel/app_id/ext_user_id/user_id). Returns ids, counts, tokens, timestamps.
- api_clients — per external app: call volume, error rate, distinct external users, tokens, estimated cost.
- ext_users — top external (v1/chat) users by (ext_user_id, app_id) plus a per-day external-active-user series.
- errors — failed LLM calls and 4xx/5xx API calls, grouped and with recent examples.

PRIVACY: never returns conversation content — no message bodies, no session titles, no prompts/outputs. Cost is an ESTIMATE from a static price table (fields suffixed _usd_est). Use period to bound the window (default 7d).`,
  category: 'super',
  is_global: false,
  icon: 'ChartColumnBig',
  group: 'admin',
  // No `surface` → default-denied from the /api/agent proxy and /api/mcp.
};

/** period → ISO lower bound (undefined = no bound). */
function periodToSince(period: AdminAnalyticsInput['period']): string | undefined {
  if (period === 'all') return undefined;
  const now = new Date();
  if (period === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const days = period === '30d' ? 30 : 7; // default 7d
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** Roll (key, model) usage rows up to per-key totals with an estimated cost. */
function priceByKey(dimRows: UsageDimensionRow[]) {
  interface Acc {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    reasoning_tokens: number;
    duration_ms: number;
    cost_usd_est: number;
    unpriced_models: Set<string>;
  }
  const map = new Map<string, Acc>();
  for (const r of dimRows) {
    let acc = map.get(r.key);
    if (!acc) {
      acc = {
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        duration_ms: 0,
        cost_usd_est: 0,
        unpriced_models: new Set(),
      };
      map.set(r.key, acc);
    }
    acc.calls += r.calls;
    acc.input_tokens += r.input_tokens;
    acc.output_tokens += r.output_tokens;
    acc.cached_tokens += r.cached_tokens;
    acc.reasoning_tokens += r.reasoning_tokens;
    acc.duration_ms += r.duration_ms;
    const cost = estimateCostUsd(r.model, r);
    if (cost == null) acc.unpriced_models.add(r.model);
    else acc.cost_usd_est += cost;
  }
  return [...map.entries()]
    .map(([key, a]) => ({
      key,
      calls: a.calls,
      input_tokens: a.input_tokens,
      output_tokens: a.output_tokens,
      cached_tokens: a.cached_tokens,
      reasoning_tokens: a.reasoning_tokens,
      duration_ms: a.duration_ms,
      cost_usd_est: Math.round(a.cost_usd_est * 10000) / 10000,
      unpriced_models: [...a.unpriced_models],
    }))
    .sort((x, y) => y.calls - x.calls);
}

export function createAdminAnalyticsTool(db: DatabaseProvider, ctx: AdminAnalyticsContext) {
  return tool({
    description: meta.description,
    inputSchema: adminAnalyticsSchema,
    execute: async (input: AdminAnalyticsInput) => {
      // Gate #3 (defense in depth) — never trust that resolution/build already
      // filtered. A non-super caller reaching here is a bug elsewhere; refuse.
      if (ctx.userRole !== 'super') {
        return { error: 'admin_analytics is restricted to super administrators.' };
      }

      try {
        const a = db.adminAnalytics;
        const since = periodToSince(input.period);
        const period = input.period ?? '7d';

        if (input.action === 'user_activity') {
          const summary = await a.userActivity({ since });
          return {
            action: input.action,
            period,
            active_users: { '1d': summary.active_1d, '7d': summary.active_7d, '30d': summary.active_30d },
            total_users: summary.users.length,
            users: summary.users.slice(0, input.limit ?? 50),
            note: 'Activity is derived from usage/message counts only — no conversation content is accessed.',
          };
        }

        if (input.action === 'usage_stats') {
          const dimension = input.group_by ?? 'model';
          const dimRows = await a.usageByDimension({ dimension, since });
          const priced = priceByKey(dimRows);
          const total = priced.reduce(
            (t, r) => {
              t.calls += r.calls;
              t.input_tokens += r.input_tokens;
              t.output_tokens += r.output_tokens;
              t.cost_usd_est += r.cost_usd_est;
              return t;
            },
            { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd_est: 0 },
          );
          total.cost_usd_est = Math.round(total.cost_usd_est * 10000) / 10000;
          return {
            action: input.action,
            period,
            group_by: dimension,
            cost_is_estimate: true,
            total,
            rows: priced.slice(0, input.limit ?? 50),
          };
        }

        if (input.action === 'sessions') {
          const list = await a.listSessions({
            channel: input.channel,
            appId: input.app_id,
            extUserId: input.ext_user_id,
            userId: input.user_id,
            since,
            limit: input.limit ?? 50,
            offset: input.offset,
          });
          return {
            action: input.action,
            period,
            found: list.length,
            sessions: list,
            note: 'Metadata only — titles and message content are intentionally excluded.',
          };
        }

        if (input.action === 'api_clients') {
          const [stats, appUsage] = await Promise.all([a.apiClientStats({ since }), a.usageByApp({ since })]);
          const costByApp = new Map(priceByKey(appUsage).map((r) => [r.key, r]));
          const clients = stats.map((s) => {
            const c = costByApp.get(s.app_id);
            return {
              ...s,
              error_rate: s.total_calls > 0 ? Math.round((s.error_calls / s.total_calls) * 1000) / 1000 : 0,
              cost_usd_est: c?.cost_usd_est ?? 0,
              unpriced_models: c?.unpriced_models ?? [],
            };
          });
          return { action: input.action, period, cost_is_estimate: true, clients };
        }

        if (input.action === 'ext_users') {
          const [top, daily] = await Promise.all([
            a.extUserStats({ appId: input.app_id, since, limit: input.limit ?? 50 }),
            a.extActivityDaily({ appId: input.app_id, since }),
          ]);
          return {
            action: input.action,
            period,
            top_users: top.map((u) => ({
              ...u,
              error_rate: u.calls > 0 ? Math.round((u.error_calls / u.calls) * 1000) / 1000 : 0,
            })),
            daily_activity: daily,
            note: 'External (v1/chat) users are identified by ext_user_id + app_id from the API audit log.',
          };
        }

        if (input.action === 'errors') {
          const report = await a.errorStats({ since, appId: input.app_id, limit: input.limit ?? 20 });
          return { action: input.action, period, ...report };
        }

        return { error: `Unknown action: ${input.action as string}` };
      } catch (err) {
        return { error: toErrorMessage(err) };
      }
    },
  });
}

export const adminAnalyticsTool = defineTool({
  meta,
  kind: 'lazy',
  requires: { user: 'super' },
  create: (ctx) => createAdminAnalyticsTool(ctx.db, { userId: ctx.userId, userRole: ctx.userRole }),
});
