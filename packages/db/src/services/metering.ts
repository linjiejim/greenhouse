/**
 * Metering service — non-model usage facts, administrative USD limits and the
 * month-bounded spend reads behind Administration › Services & pricing and
 * Settings › Usage.
 *
 * Model facts stay in llm_usage (written by `usage.record`); this service owns
 * `service_usage` and `usage_budget_limits`, and reads both fact tables
 * together. Every read is bounded to one half-open period and served by a
 * `(…, created_at)` index.
 */

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { serviceUsage, usageBudgetAccounts, usageBudgetLimits, usagePriceOverrides } from '../schema/index.js';
import type {
  ServiceUsageRow,
  UsageBudgetAccountRow,
  UsageBudgetLimitRow,
  UsageBudgetLimitScopeType,
  UsagePriceOverrideRow,
} from '../schema/usage.js';

export interface ServiceUsageInput {
  user_id?: string | null;
  service: string;
  provider: string;
  model?: string | null;
  units: number;
  unit_kind: ServiceUsageRow['unit_kind'];
  /** Null = unpriced. */
  cost_usd_micros: number | null;
  client?: string | null;
  oauth_client_id?: string | null;
  caller?: string;
  run_id?: string | null;
  session_id?: string | null;
  budget_idempotency_key?: string | null;
  /** The price this call was settled at (source + rate), JSON-serializable. */
  price_applied?: Readonly<Record<string, unknown>> | null;
  metadata?: Readonly<Record<string, unknown>>;
  created_at?: string;
}

export interface UsagePriceOverrideInput {
  kind: UsagePriceOverrideRow['kind'];
  target: string;
  /** Service provider; omitted / '' for a model. */
  provider?: string;
  input_per_mtok?: number | null;
  output_per_mtok?: number | null;
  cached_input_per_mtok?: number | null;
  unit_price?: number | null;
  actor_id?: string | null;
}

export function usagePriceOverrideId(kind: UsagePriceOverrideRow['kind'], target: string, provider = ''): string {
  const digest = createHash('sha256').update(`${kind}\u0000${target}\u0000${provider}`).digest('hex');
  return `upo_${digest.slice(0, 32)}`;
}

function assertRate(value: number | null | undefined, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

export type SpendDimension = 'member' | 'service' | 'client' | 'agent_client';

export interface SpendQuery {
  since: string;
  until: string;
  /** Restrict to one member's facts. */
  user_id?: string;
  /** Max groups returned (most expensive first); default 200. */
  limit?: number;
}

export interface SpendGroupRow {
  key: string;
  label: string | null;
  cost_usd_micros: number;
  calls: number;
  unpriced_calls: number;
}

export interface SpendTotalsRow {
  cost_usd_micros: number;
  calls: number;
  unpriced_calls: number;
}

export interface UsageBudgetLimitInput {
  scope_type: UsageBudgetLimitScopeType;
  scope_id: string;
  limit_units: number;
  actor_id?: string | null;
}

/** The member-default limit row's scope id. */
export const MEMBER_DEFAULT_SCOPE_ID = '*';

export function usageBudgetLimitId(scopeType: UsageBudgetLimitScopeType, scopeId: string): string {
  const digest = createHash('sha256').update(`${scopeType}\u0000${scopeId}\u0000usd_micros`).digest('hex');
  return `ubl_${digest.slice(0, 32)}`;
}

function assertNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

/**
 * Both fact tables as one relation: (user_id, service, client, oauth_client_id,
 * cost, created_at). llm_usage rows written before metering carry no service;
 * their caller says which one it was.
 */
function factsWithin(since: string, until: string, userId?: string) {
  const llmUser = userId ? sql`AND user_id = ${userId}` : sql``;
  const svcUser = userId ? sql`AND user_id = ${userId}` : sql``;
  return sql`(
    SELECT user_id,
           COALESCE(service, CASE caller WHEN 'vision' THEN 'vision' WHEN 'generate-image' THEN 'image_generation' ELSE 'llm' END) AS service,
           client, oauth_client_id, cost_usd_micros
      FROM llm_usage
     WHERE created_at >= ${since} AND created_at < ${until} ${llmUser}
    UNION ALL
    SELECT user_id, service, client, oauth_client_id, cost_usd_micros
      FROM service_usage
     WHERE created_at >= ${since} AND created_at < ${until} ${svcUser}
  ) AS facts`;
}

interface RawSpendRow {
  key: string | null;
  label: string | null;
  cost_usd_micros: string | number | null;
  calls: string | number;
  unpriced_calls: string | number;
}

function toSpendRow(row: RawSpendRow): SpendGroupRow {
  return {
    key: row.key ?? '',
    label: row.label ?? null,
    cost_usd_micros: Number(row.cost_usd_micros ?? 0),
    calls: Number(row.calls ?? 0),
    unpriced_calls: Number(row.unpriced_calls ?? 0),
  };
}

export function createMeteringService(db: Db) {
  const service = {
    /** Append one non-model fact. */
    async recordService(input: ServiceUsageInput): Promise<ServiceUsageRow> {
      const units = assertNonNegativeInteger(input.units, 'units');
      if (input.cost_usd_micros !== null) assertNonNegativeInteger(input.cost_usd_micros, 'cost_usd_micros');
      const [row] = await db
        .insert(serviceUsage)
        .values({
          id: `svu_${randomUUID().replaceAll('-', '')}`,
          user_id: input.user_id ?? null,
          service: input.service,
          provider: input.provider,
          model: input.model ?? null,
          units,
          unit_kind: input.unit_kind,
          cost_usd_micros: input.cost_usd_micros,
          client: input.client ?? null,
          oauth_client_id: input.oauth_client_id ?? null,
          caller: input.caller ?? '',
          run_id: input.run_id ?? null,
          session_id: input.session_id ?? null,
          budget_idempotency_key: input.budget_idempotency_key ?? null,
          price_applied: input.price_applied ? JSON.stringify(input.price_applied) : null,
          metadata: JSON.stringify(input.metadata ?? {}),
          created_at: input.created_at ?? nowIso(),
        })
        .returning();
      return row!;
    },

    async listServiceUsageByKey(budgetIdempotencyKey: string): Promise<ServiceUsageRow[]> {
      return db
        .select()
        .from(serviceUsage)
        .where(eq(serviceUsage.budget_idempotency_key, budgetIdempotencyKey))
        .orderBy(asc(serviceUsage.created_at));
    },

    // ─── Limits ────────────────────────────────────────────

    async listLimits(): Promise<UsageBudgetLimitRow[]> {
      return db
        .select()
        .from(usageBudgetLimits)
        .orderBy(asc(usageBudgetLimits.scope_type), asc(usageBudgetLimits.scope_id));
    },

    /** The limit rows that could apply to one call: organization, a service, the member default and one member. */
    async getLimits(
      scopes: ReadonlyArray<{ scope_type: UsageBudgetLimitScopeType; scope_id: string }>,
    ): Promise<UsageBudgetLimitRow[]> {
      if (scopes.length === 0) return [];
      const ids = scopes.map((scope) => usageBudgetLimitId(scope.scope_type, scope.scope_id));
      return db.select().from(usageBudgetLimits).where(inArray(usageBudgetLimits.id, ids));
    },

    async setLimit(input: UsageBudgetLimitInput): Promise<UsageBudgetLimitRow> {
      const scopeId = input.scope_id.trim();
      if (!scopeId || scopeId.length > 512) throw new Error('scope_id must contain 1-512 characters');
      const limit = assertNonNegativeInteger(input.limit_units, 'limit_units');
      const at = nowIso();
      const [row] = await db
        .insert(usageBudgetLimits)
        .values({
          id: usageBudgetLimitId(input.scope_type, scopeId),
          scope_type: input.scope_type,
          scope_id: scopeId,
          unit: 'usd_micros',
          limit_units: limit,
          updated_by: input.actor_id ?? null,
          created_at: at,
          updated_at: at,
        })
        .onConflictDoUpdate({
          target: usageBudgetLimits.id,
          set: { limit_units: limit, updated_by: input.actor_id ?? null, updated_at: at },
        })
        .returning();
      return row!;
    },

    /** Drop an override so the env / default limit applies again. */
    async deleteLimit(scopeType: UsageBudgetLimitScopeType, scopeId: string): Promise<boolean> {
      const rows = await db
        .delete(usageBudgetLimits)
        .where(eq(usageBudgetLimits.id, usageBudgetLimitId(scopeType, scopeId.trim())))
        .returning({ id: usageBudgetLimits.id });
      return rows.length > 0;
    },

    // ─── Price overrides ───────────────────────────────────

    async listPriceOverrides(): Promise<UsagePriceOverrideRow[]> {
      return db
        .select()
        .from(usagePriceOverrides)
        .orderBy(asc(usagePriceOverrides.kind), asc(usagePriceOverrides.target), asc(usagePriceOverrides.provider));
    },

    /** Replace the whole override for one model or service × provider (fields left out become null). */
    async setPriceOverride(input: UsagePriceOverrideInput): Promise<UsagePriceOverrideRow> {
      const target = input.target.trim();
      const provider = (input.provider ?? '').trim();
      if (!target || target.length > 200 || provider.length > 200) throw new Error('target/provider is invalid');
      const values = {
        input_per_mtok: assertRate(input.input_per_mtok, 'input_per_mtok'),
        output_per_mtok: assertRate(input.output_per_mtok, 'output_per_mtok'),
        cached_input_per_mtok: assertRate(input.cached_input_per_mtok, 'cached_input_per_mtok'),
        unit_price: assertRate(input.unit_price, 'unit_price'),
      };
      const at = nowIso();
      const [row] = await db
        .insert(usagePriceOverrides)
        .values({
          id: usagePriceOverrideId(input.kind, target, provider),
          kind: input.kind,
          target,
          provider,
          ...values,
          updated_by: input.actor_id ?? null,
          created_at: at,
          updated_at: at,
        })
        .onConflictDoUpdate({
          target: usagePriceOverrides.id,
          set: { ...values, updated_by: input.actor_id ?? null, updated_at: at },
        })
        .returning();
      return row!;
    },

    async deletePriceOverride(kind: UsagePriceOverrideRow['kind'], target: string, provider = ''): Promise<boolean> {
      const rows = await db
        .delete(usagePriceOverrides)
        .where(eq(usagePriceOverrides.id, usagePriceOverrideId(kind, target.trim(), provider.trim())))
        .returning({ id: usagePriceOverrides.id });
      return rows.length > 0;
    },

    // ─── Spend reads ───────────────────────────────────────

    async spendTotals(query: SpendQuery): Promise<SpendTotalsRow> {
      const rows = (await db.execute(sql`
        SELECT COALESCE(SUM(cost_usd_micros), 0) AS cost_usd_micros,
               COUNT(*) AS calls,
               COUNT(*) FILTER (WHERE cost_usd_micros IS NULL) AS unpriced_calls
          FROM ${factsWithin(query.since, query.until, query.user_id)}
      `)) as unknown as RawSpendRow[];
      const row = rows[0];
      return {
        cost_usd_micros: Number(row?.cost_usd_micros ?? 0),
        calls: Number(row?.calls ?? 0),
        unpriced_calls: Number(row?.unpriced_calls ?? 0),
      };
    },

    /** Spend grouped by one dimension, most expensive first. */
    async spendBy(dimension: SpendDimension, query: SpendQuery): Promise<SpendGroupRow[]> {
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 200), 1), 1_000);
      const facts = factsWithin(query.since, query.until, query.user_id);
      const aggregates = sql`COALESCE(SUM(facts.cost_usd_micros), 0) AS cost_usd_micros,
               COUNT(*) AS calls,
               COUNT(*) FILTER (WHERE facts.cost_usd_micros IS NULL) AS unpriced_calls`;
      let statement;
      switch (dimension) {
        case 'member':
          statement = sql`
            SELECT facts.user_id AS key, COALESCE(MAX(u.nickname), MAX(u.email)) AS label, ${aggregates}
              FROM ${facts}
              LEFT JOIN users u ON u.id = facts.user_id
             GROUP BY facts.user_id
             ORDER BY 3 DESC, 4 DESC
             LIMIT ${limit}`;
          break;
        case 'service':
          statement = sql`
            SELECT facts.service AS key, NULL AS label, ${aggregates}
              FROM ${facts}
             GROUP BY facts.service
             ORDER BY 3 DESC, 4 DESC
             LIMIT ${limit}`;
          break;
        case 'client':
          statement = sql`
            SELECT COALESCE(facts.client, '') AS key, NULL AS label, ${aggregates}
              FROM ${facts}
             GROUP BY COALESCE(facts.client, '')
             ORDER BY 3 DESC, 4 DESC
             LIMIT ${limit}`;
          break;
        case 'agent_client':
          statement = sql`
            SELECT facts.oauth_client_id AS key, MAX(c.client_name) AS label, ${aggregates}
              FROM ${facts}
              LEFT JOIN platform_oauth_clients c ON c.id = facts.oauth_client_id
             WHERE facts.oauth_client_id IS NOT NULL
             GROUP BY facts.oauth_client_id
             ORDER BY 3 DESC, 4 DESC
             LIMIT ${limit}`;
          break;
      }
      const rows = (await db.execute(statement)) as unknown as RawSpendRow[];
      return rows.map(toSpendRow);
    },

    /**
     * USD charged by reservations that expired with their outcome unknown (the
     * call started and never settled): the gap between an account's spent and
     * the per-call facts. Read at one level only so the three-level charge is
     * not counted three times.
     */
    async unsettledUsdMicros(input: {
      period_start: string;
      period_end: string;
      scope_type: 'organization' | 'user';
      scope_id?: string;
    }): Promise<number> {
      const scope = input.scope_id ? sql`AND a.scope_id = ${input.scope_id}` : sql``;
      const rows = (await db.execute(sql`
        SELECT COALESCE(SUM(COALESCE(r.actual_units, r.estimated_units)), 0) AS total
          FROM usage_budget_reservations r
          JOIN usage_budget_accounts a ON a.id = r.account_id
         WHERE r.status = 'expired'
           AND a.unit = 'usd_micros'
           AND a.scope_type = ${input.scope_type}
           AND a.period_start = ${input.period_start}
           AND a.period_end = ${input.period_end}
           ${scope}
      `)) as unknown as Array<{ total: string | number }>;
      return Number(rows[0]?.total ?? 0);
    },

    /** This period's USD accounts at the metered levels (member / service / organization). */
    async listUsdAccounts(input: { period_start: string; period_end: string }): Promise<UsageBudgetAccountRow[]> {
      return db
        .select()
        .from(usageBudgetAccounts)
        .where(
          and(
            eq(usageBudgetAccounts.unit, 'usd_micros'),
            eq(usageBudgetAccounts.period_start, input.period_start),
            eq(usageBudgetAccounts.period_end, input.period_end),
            inArray(usageBudgetAccounts.scope_type, ['user', 'service', 'organization']),
          ),
        )
        .orderBy(asc(usageBudgetAccounts.scope_type), asc(usageBudgetAccounts.scope_id));
    },

    /** Several accounts by id (snapshot reads for admission and alerts). */
    async getAccounts(ids: readonly string[]): Promise<UsageBudgetAccountRow[]> {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(usageBudgetAccounts)
        .where(inArray(usageBudgetAccounts.id, [...ids]))
        .orderBy(asc(usageBudgetAccounts.id));
    },
  };
  return service;
}

export type MeteringService = ReturnType<typeof createMeteringService>;
