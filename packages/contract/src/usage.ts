import { z } from 'zod';
import { isoTime } from './common.js';

/**
 * Usage comes from usage_events, one row per provider call. `month` is the current UTC calendar
 * month (the budget period); `30d` the last 30 days. Days are UTC days.
 */
export const USAGE_PERIODS = ['month', '30d'] as const;
export const usageQuerySchema = z.object({ period: z.enum(USAGE_PERIODS).default('month') });

export const usagePeriodSchema = z.object({ name: z.enum(USAGE_PERIODS), start: isoTime, end: isoTime });
export type UsagePeriod = z.infer<typeof usagePeriodSchema>;

export const usageTotalsSchema = z.object({
  /** Provider calls. */
  requests: z.number().int(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  /** Part of the input tokens served from the vendor's cache. */
  cached_tokens: z.number().int(),
  /** cached_tokens / input_tokens: how much of the prompts the vendor read from its cache. Null without input. */
  cache_hit_rate: z.number().min(0).max(1).nullable(),
  /** Input plus output: what token budgets count. */
  tokens: z.number().int(),
  /** STT audio seconds and TTS characters, kept in their original units. */
  stt_seconds: z.number().nonnegative(),
  tts_characters: z.number().nonnegative(),
  /** Estimated cost in millionths of a US dollar, from the calls whose price is known. */
  cost_micros: z.number().int(),
  /** Calls whose cost is unknown (their model has no price), so cost_micros leaves them out. */
  unpriced: z.number().int(),
});
export type UsageTotals = z.infer<typeof usageTotalsSchema>;

/** 设置 → 用量: my own usage, whoever's key served it. */
export const myUsageSchema = z.object({
  period: usagePeriodSchema,
  totals: usageTotalsSchema,
  by_capability: z.array(usageTotalsSchema.extend({ capability: z.string() })),
  /** Agents I used, mine and public ones; null is usage outside any Agent (titles, summaries). */
  by_agent: z.array(usageTotalsSchema.extend({ agent_id: z.string().nullable(), name: z.string() })),
  /** Every UTC day of the period, oldest first, zeros included. */
  by_day: z.array(usageTotalsSchema.extend({ day: z.string() })),
  /** My member budgets this month. */
  budgets: z.array(
    z.object({ unit: z.enum(['tokens', 'usd_micros']), monthly_limit: z.number().int(), spent: z.number().int() }),
  ),
});
export type MyUsage = z.infer<typeof myUsageSchema>;

export const USAGE_GROUPS = ['member', 'agent', 'provider', 'capability'] as const;
export const adminUsageQuerySchema = usageQuerySchema.extend({ group_by: z.enum(USAGE_GROUPS).default('member') });

/** 管理 → 用量: the workspace, every source included, grouped one way. */
export const adminUsageSchema = z.object({
  period: usagePeriodSchema,
  group_by: z.enum(USAGE_GROUPS),
  totals: usageTotalsSchema,
  /** Most tokens first. `detail`: a member's email, an Agent's owner, a provider's capability. */
  groups: z.array(usageTotalsSchema.extend({ key: z.string().nullable(), label: z.string(), detail: z.string() })),
});
export type AdminUsage = z.infer<typeof adminUsageSchema>;

/** The PRD's three levels; personal-key usage counts only where the capability's policy says so. */
export const BUDGET_SCOPES = ['workspace', 'provider', 'member'] as const;
export const BUDGET_UNITS = ['tokens', 'usd_micros'] as const;

/** Creates or replaces the budget of one scope and unit. */
export const budgetInputSchema = z
  .object({
    scope_type: z.enum(BUDGET_SCOPES),
    /** A provider instance id or a member id; none for the workspace. */
    scope_id: z.string().min(1).max(64).optional(),
    unit: z.enum(BUDGET_UNITS),
    monthly_limit: z.number().int().min(1).max(1e15),
    enabled: z.boolean().default(true),
  })
  .refine((input) => (input.scope_type === 'workspace') === (input.scope_id === undefined), {
    message: 'A provider or member budget names its scope_id; the workspace budget has none.',
    path: ['scope_id'],
  });
export type BudgetInput = z.input<typeof budgetInputSchema>;

export const budgetSchema = z.object({
  id: z.string(),
  scope_type: z.enum(BUDGET_SCOPES),
  scope_id: z.string(),
  /** The member's or instance's name; the workspace's name. */
  scope_name: z.string(),
  unit: z.enum(BUDGET_UNITS),
  monthly_limit: z.number().int(),
  enabled: z.boolean(),
  /** The current UTC month. */
  period_start: isoTime,
  period_end: isoTime,
  spent: z.number().int(),
  /** Calls it covers are refused until the month ends or the limit rises. */
  exceeded: z.boolean(),
  created_at: isoTime,
});
export type Budget = z.infer<typeof budgetSchema>;

/** How runs ended: active is queued, running or waiting. */
export const runOutcomesSchema = z.object({
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  canceled: z.number().int(),
  active: z.number().int(),
});

/** An Agent's usage for its owner: counts and ratings, never what anyone said. */
export const agentUsageSchema = z.object({
  agent_id: z.string(),
  period: usagePeriodSchema,
  /** Every member's usage of it, its owner's included. */
  totals: usageTotalsSchema,
  /** Replies. */
  turns: runOutcomesSchema,
  background_runs: runOutcomesSchema,
  /** Members other than its owner who talked to it in the period. */
  people: z.number().int(),
  ratings: z.object({
    up: z.number().int(),
    down: z.number().int(),
    /** The newest comments, without who wrote them. */
    comments: z.array(
      z.object({
        rating: z.number().int(),
        comment: z.string(),
        version: z.number().int().nullable(),
        created_at: isoTime,
      }),
    ),
  }),
});
export type AgentUsage = z.infer<typeof agentUsageSchema>;

/** One run of an Agent. Someone else's reply shows only its status and times. */
export const agentActivitySchema = z.object({
  id: z.string(),
  kind: z.enum(['turn', 'background']),
  source: z.string(),
  title: z.string(),
  status: z.string(),
  error_code: z.string().nullable(),
  /** Started by its owner; the others are replies of a public Agent to its audience. */
  mine: z.boolean(),
  /** Where it ran, for the owner's own runs. */
  conversation_id: z.string().nullable(),
  started_at: isoTime.nullable(),
  finished_at: isoTime.nullable(),
  created_at: isoTime,
});
export type AgentActivity = z.infer<typeof agentActivitySchema>;
