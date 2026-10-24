/**
 * Metering service — non-model usage facts, administrative USD limits and the
 * month-bounded spend reads behind Administration › Services & pricing and
 * Settings › Usage.
 *
 * Model facts are `usage_events` of kind `model` (written by `usage.record`);
 * this service writes kind `service`, owns the `limit` rows of `budgets` and
 * the `prices` table, and reads both spend kinds together (never `audit`, which
 * carries no units). Every read is bounded to one half-open period and served
 * by a `(…, created_at)` index.
 */

import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { budgets, prices, usageEvents } from '../schema/index.js';
import type { BudgetRow, UsageEventRow, UsagePriceOverrideRow } from '../schema/usage.js';
import { toUsageBudgetAccount, type UsageBudgetAccountRow } from './usage-budget.js';

/** A non-model usage fact: a `usage_events` row of kind `service`. */
export interface ServiceUsageRow {
  id: string;
  user_id: string | null;
  service: string;
  provider: string;
  model: string | null;
  units: number;
  unit_kind: UsageEventRow['unit_kind'];
  cost_usd_micros: number | null;
  client: string | null;
  oauth_client_id: string | null;
  caller: string;
  run_id: string | null;
  session_id: string | null;
  budget_idempotency_key: string | null;
  price_applied: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

function toServiceUsageRow(row: UsageEventRow): ServiceUsageRow {
  return {
    id: row.id,
    user_id: row.user_id,
    service: row.service ?? '',
    provider: row.provider ?? '',
    model: row.model,
    units: row.units,
    unit_kind: row.unit_kind,
    cost_usd_micros: row.cost_usd_micros,
    client: row.client,
    oauth_client_id: row.oauth_client_id,
    caller: row.caller,
    run_id: row.run_id,
    session_id: row.session_id,
    budget_idempotency_key: row.budget_idempotency_key,
    price_applied: row.price_applied ?? null,
    metadata: row.detail,
    created_at: row.created_at,
  };
}

export type UsageBudgetLimitScopeType = 'organization' | 'service' | 'user';
const LIMIT_SCOPE_TYPES: readonly UsageBudgetLimitScopeType[] = ['organization', 'service', 'user'];

/** An administrative USD limit: a `budgets` row of kind `limit` (no period). */
export interface UsageBudgetLimitRow {
  id: string;
  scope_type: UsageBudgetLimitScopeType;
  scope_id: string;
  unit: 'usd_micros';
  limit_units: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

function toLimitRow(row: BudgetRow): UsageBudgetLimitRow {
  return {
    id: row.id,
    scope_type: row.scope_type as UsageBudgetLimitScopeType,
    scope_id: row.scope_id,
    unit: 'usd_micros',
    limit_units: row.limit_units,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const isLimit = and(eq(budgets.kind, 'limit'), eq(budgets.unit, 'usd_micros'));

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

function assertNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

/**
 * The spend facts (model + service events) as one relation: (user_id, service,
 * client, oauth_client_id, cost). Model rows written before metering carry no
 * service; their caller says which one it was. `audit` rows never count.
 */
function factsWithin(since: string, until: string, userId?: string) {
  const user = userId ? sql`AND user_id = ${userId}` : sql``;
  return sql`(
    SELECT user_id,
           COALESCE(service, CASE caller WHEN 'vision' THEN 'vision' WHEN 'generate-image' THEN 'image_generation' ELSE 'llm' END) AS service,
           client, oauth_client_id, cost_usd_micros
      FROM usage_events
     WHERE kind IN ('model', 'service')
       AND created_at >= ${since} AND created_at < ${until} ${user}
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
        .insert(usageEvents)
        .values({
          id: newId('usageEvent'),
          kind: 'service',
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
          price_applied: input.price_applied ? { ...input.price_applied } : null,
          detail: { ...input.metadata },
          created_at: input.created_at ?? nowIso(),
        })
        .returning();
      return toServiceUsageRow(row!);
    },

    async listServiceUsageByKey(budgetIdempotencyKey: string): Promise<ServiceUsageRow[]> {
      const rows = await db
        .select()
        .from(usageEvents)
        .where(and(eq(usageEvents.kind, 'service'), eq(usageEvents.budget_idempotency_key, budgetIdempotencyKey)))
        .orderBy(asc(usageEvents.created_at), asc(usageEvents.id));
      return rows.map(toServiceUsageRow);
    },

    // ─── Limits ────────────────────────────────────────────

    async listLimits(): Promise<UsageBudgetLimitRow[]> {
      const rows = await db
        .select()
        .from(budgets)
        .where(and(isLimit, inArray(budgets.scope_type, [...LIMIT_SCOPE_TYPES])))
        .orderBy(asc(budgets.scope_type), asc(budgets.scope_id));
      return rows.map(toLimitRow);
    },

    /** The limit rows that could apply to one call: organization, a service, the member default and one member. */
    async getLimits(
      scopes: ReadonlyArray<{ scope_type: UsageBudgetLimitScopeType; scope_id: string }>,
    ): Promise<UsageBudgetLimitRow[]> {
      if (scopes.length === 0) return [];
      const rows = await db
        .select()
        .from(budgets)
        .where(
          and(
            isLimit,
            or(
              ...scopes.map((scope) =>
                and(eq(budgets.scope_type, scope.scope_type), eq(budgets.scope_id, scope.scope_id)),
              ),
            ),
          ),
        );
      return rows.map(toLimitRow);
    },

    async setLimit(input: UsageBudgetLimitInput): Promise<UsageBudgetLimitRow> {
      const scopeId = input.scope_id.trim();
      if (!scopeId || scopeId.length > 512) throw new Error('scope_id must contain 1-512 characters');
      const limit = assertNonNegativeInteger(input.limit_units, 'limit_units');
      const at = nowIso();
      const [row] = await db
        .insert(budgets)
        .values({
          id: newId('budget'),
          kind: 'limit',
          scope_type: input.scope_type,
          scope_id: scopeId,
          unit: 'usd_micros',
          limit_units: limit,
          updated_by: input.actor_id ?? null,
          created_at: at,
          updated_at: at,
        })
        .onConflictDoUpdate({
          target: [budgets.scope_type, budgets.scope_id, budgets.unit],
          targetWhere: sql`kind = 'limit'`,
          set: { limit_units: limit, updated_by: input.actor_id ?? null, updated_at: at },
        })
        .returning();
      return toLimitRow(row!);
    },

    /** Drop an override so the env / default limit applies again. */
    async deleteLimit(scopeType: UsageBudgetLimitScopeType, scopeId: string): Promise<boolean> {
      const rows = await db
        .delete(budgets)
        .where(and(isLimit, eq(budgets.scope_type, scopeType), eq(budgets.scope_id, scopeId.trim())))
        .returning({ id: budgets.id });
      return rows.length > 0;
    },

    // ─── Price overrides ───────────────────────────────────

    async listPriceOverrides(): Promise<UsagePriceOverrideRow[]> {
      return db.select().from(prices).orderBy(asc(prices.kind), asc(prices.target), asc(prices.provider));
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
        .insert(prices)
        .values({
          id: newId('price'),
          kind: input.kind,
          target,
          provider,
          ...values,
          updated_by: input.actor_id ?? null,
          created_at: at,
          updated_at: at,
        })
        .onConflictDoUpdate({
          target: [prices.kind, prices.target, prices.provider],
          set: { ...values, updated_by: input.actor_id ?? null, updated_at: at },
        })
        .returning();
      return row!;
    },

    async deletePriceOverride(kind: UsagePriceOverrideRow['kind'], target: string, provider = ''): Promise<boolean> {
      const rows = await db
        .delete(prices)
        .where(and(eq(prices.kind, kind), eq(prices.target, target.trim()), eq(prices.provider, provider.trim())))
        .returning({ id: prices.id });
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
              LEFT JOIN oauth_clients c ON c.id = facts.oauth_client_id
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
          FROM budget_reservations r
          JOIN budgets a ON a.id = r.account_id
         WHERE r.status = 'expired'
           AND a.kind = 'account'
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
      const rows = await db
        .select()
        .from(budgets)
        .where(
          and(
            eq(budgets.kind, 'account'),
            eq(budgets.unit, 'usd_micros'),
            eq(budgets.period_start, input.period_start),
            eq(budgets.period_end, input.period_end),
            inArray(budgets.scope_type, ['user', 'service', 'organization']),
          ),
        )
        .orderBy(asc(budgets.scope_type), asc(budgets.scope_id));
      return rows.map(toUsageBudgetAccount);
    },

    /** Several accounts by id (snapshot reads for admission and alerts). */
    async getAccounts(ids: readonly string[]): Promise<UsageBudgetAccountRow[]> {
      if (ids.length === 0) return [];
      const rows = await db
        .select()
        .from(budgets)
        .where(and(eq(budgets.kind, 'account'), inArray(budgets.id, [...ids])))
        .orderBy(asc(budgets.id));
      return rows.map(toUsageBudgetAccount);
    },
  };
  return service;
}

export type MeteringService = ReturnType<typeof createMeteringService>;
