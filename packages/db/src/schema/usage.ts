/**
 * Usage: one fact per metered call, budgets with their reservations and ledger,
 * super-set prices and daily module counters.
 *
 * Tables: usage_events, budgets, budget_reservations, budget_ledger, prices,
 * module_usage_daily
 *
 * - `usage_events.kind`: `model` (a chat-model call: tokens), `service` (a
 *   non-model paid call: web search, image, computer minutes) or `audit` (the
 *   prompt / output record of a `call_llm` sub-call; carries no units, so it
 *   never adds to spend). Subjects are logical references; the fact outlives them.
 * - `budgets.kind`: `account` is one hard-limit balance for one scope and one
 *   half-open period (reserved / spent move only through the ledger); `limit`
 *   is an administrative USD limit that outlives periods (organization /
 *   service / `user` + `*` default / `user` + member id) from which monthly
 *   accounts are materialized.
 * - The ledger is append-only and kept 13 months (`retention.ts`).
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { at, createdAt, day, id, json, jsonOrNull, oneOf, updatedAt } from './_columns.js';

export const USAGE_EVENT_KINDS = ['model', 'service', 'audit'] as const;
export const USAGE_UNIT_KINDS = ['token', 'call', 'image', 'minute'] as const;

export const usageEvents = pgTable(
  'usage_events',
  {
    id: id(),
    kind: text('kind', { enum: USAGE_EVENT_KINDS }).notNull(),
    /** Metered service: `llm`, `vision`, `web_search`, `image`, `computer`, … */
    service: text('service'),
    provider: text('provider'),
    model: text('model'),
    /** Agent profile the call ran as (model calls). */
    profile_id: text('profile_id'),
    /** What made the call: `chat`, `call_llm`, `title`, `gateway`, … */
    caller: text('caller').notNull().default(''),
    units: bigint('units', { mode: 'number' }).notNull().default(0),
    unit_kind: text('unit_kind', { enum: USAGE_UNIT_KINDS }).notNull().default('token'),
    input_tokens: integer('input_tokens').notNull().default(0),
    output_tokens: integer('output_tokens').notNull().default(0),
    cached_tokens: integer('cached_tokens').notNull().default(0),
    reasoning_tokens: integer('reasoning_tokens').notNull().default(0),
    duration_ms: integer('duration_ms'),
    /** Null = unpriced (counted as zero, reported separately). */
    cost_usd_micros: bigint('cost_usd_micros', { mode: 'number' }),
    /** Snapshot of the price applied at settlement (source + rates). */
    price_applied: jsonOrNull<Record<string, unknown>>('price_applied'),
    user_id: text('user_id'),
    /** `@greenhouse/types/metering` METERING_CLIENTS: web / mobile / mcp / automation / … */
    client: text('client'),
    oauth_client_id: text('oauth_client_id'),
    gateway_key_id: text('gateway_key_id'),
    session_id: text('session_id'),
    run_id: text('run_id'),
    budget_idempotency_key: text('budget_idempotency_key'),
    /** Kind-specific details (service metadata; the call_llm prompt and output for `audit`). */
    detail: json<Record<string, unknown>>('detail', {}),
    created_at: createdAt(),
  },
  (table) => [
    index('idx_usage_events_created').on(table.created_at),
    index('idx_usage_events_user_created').on(table.user_id, table.created_at),
    index('idx_usage_events_kind_created').on(table.kind, table.created_at),
    index('idx_usage_events_service_created').on(table.service, table.created_at),
    index('idx_usage_events_session').on(table.session_id),
    index('idx_usage_events_gateway_key').on(table.gateway_key_id, table.created_at),
    index('idx_usage_events_budget_key').on(table.budget_idempotency_key),
    oneOf('chk_usage_events_kind', table.kind, USAGE_EVENT_KINDS),
    oneOf('chk_usage_events_unit_kind', table.unit_kind, USAGE_UNIT_KINDS),
  ],
);

export const BUDGET_KINDS = ['account', 'limit'] as const;
export const BUDGET_SCOPE_TYPES = ['user', 'organization', 'agent', 'run', 'eval', 'provider', 'service'] as const;
export const BUDGET_UNITS = ['tokens', 'requests', 'usd_micros'] as const;
export const BUDGET_STATUSES = ['active', 'disabled'] as const;

export const budgets = pgTable(
  'budgets',
  {
    id: id(),
    kind: text('kind', { enum: BUDGET_KINDS }).notNull(),
    scope_type: text('scope_type', { enum: BUDGET_SCOPE_TYPES }).notNull(),
    scope_id: text('scope_id').notNull(),
    unit: text('unit', { enum: BUDGET_UNITS }).notNull().default('usd_micros'),
    status: text('status', { enum: BUDGET_STATUSES }).notNull().default('active'),
    /** Accounts only: inclusive start / exclusive end of the accounting period. */
    period_start: at('period_start'),
    period_end: at('period_end'),
    limit_units: bigint('limit_units', { mode: 'number' }).notNull(),
    reserved_units: bigint('reserved_units', { mode: 'number' }).notNull().default(0),
    spent_units: bigint('spent_units', { mode: 'number' }).notNull().default(0),
    updated_by: text('updated_by'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_budgets_account')
      .on(table.scope_type, table.scope_id, table.unit, table.period_start, table.period_end)
      .where(sql`${table.kind} = 'account'`),
    uniqueIndex('uq_budgets_limit')
      .on(table.scope_type, table.scope_id, table.unit)
      .where(sql`${table.kind} = 'limit'`),
    index('idx_budgets_scope').on(table.scope_type, table.scope_id, table.status),
    index('idx_budgets_period').on(table.period_start, table.period_end),
    oneOf('chk_budgets_kind', table.kind, BUDGET_KINDS),
    oneOf('chk_budgets_scope_type', table.scope_type, BUDGET_SCOPE_TYPES),
    oneOf('chk_budgets_unit', table.unit, BUDGET_UNITS),
    oneOf('chk_budgets_status', table.status, BUDGET_STATUSES),
    check(
      'chk_budgets_period',
      sql`(${table.kind} = 'limit' AND ${table.period_start} IS NULL AND ${table.period_end} IS NULL) OR (${table.kind} = 'account' AND ${table.period_end} > ${table.period_start})`,
    ),
    check(
      'chk_budgets_nonnegative',
      sql`${table.limit_units} >= 0 AND ${table.reserved_units} >= 0 AND ${table.spent_units} >= 0`,
    ),
  ],
);

export const RESERVATION_STATUSES = ['reserved', 'settled', 'released', 'expired'] as const;

/**
 * One row per account charged by a logical call. Rows sharing an
 * idempotency_key are one reservation group, so a call atomically debits
 * member + organization + service accounts.
 */
export const budgetReservations = pgTable(
  'budget_reservations',
  {
    id: id(),
    account_id: text('account_id').notNull(),
    idempotency_key: text('idempotency_key').notNull(),
    /** Hash of the immutable reservation request; detects key reuse drift. */
    request_hash: text('request_hash').notNull(),
    status: text('status', { enum: RESERVATION_STATUSES }).notNull().default('reserved'),
    estimated_units: bigint('estimated_units', { mode: 'number' }).notNull(),
    actual_units: bigint('actual_units', { mode: 'number' }),
    caller: text('caller').notNull(),
    user_id: text('user_id'),
    run_id: text('run_id'),
    provider_id: text('provider_id'),
    model_id: text('model_id'),
    metadata: json<Record<string, unknown>>('metadata', {}),
    expires_at: at('expires_at').notNull(),
    settled_at: at('settled_at'),
    released_at: at('released_at'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_budget_reservations_account_key').on(table.account_id, table.idempotency_key),
    index('idx_budget_reservations_key').on(table.idempotency_key),
    index('idx_budget_reservations_status_expiry').on(table.status, table.expires_at),
    index('idx_budget_reservations_user_created').on(table.user_id, table.created_at),
    index('idx_budget_reservations_run').on(table.run_id),
    oneOf('chk_budget_reservations_status', table.status, RESERVATION_STATUSES),
    check('chk_budget_reservations_estimate', sql`${table.estimated_units} > 0`),
    check('chk_budget_reservations_actual', sql`${table.actual_units} IS NULL OR ${table.actual_units} >= 0`),
  ],
);

export const LEDGER_ENTRY_TYPES = [
  'bootstrap',
  'reconcile',
  'reserve',
  'settle',
  'release',
  'expire',
  'adjustment',
  'status',
] as const;

export const budgetLedger = pgTable(
  'budget_ledger',
  {
    id: id(),
    account_id: text('account_id').notNull(),
    reservation_id: text('reservation_id'),
    /** Per-account immutable transition key; prevents duplicate ledger effects. */
    operation_key: text('operation_key').notNull(),
    entry_type: text('entry_type', { enum: LEDGER_ENTRY_TYPES }).notNull(),
    delta_reserved_units: bigint('delta_reserved_units', { mode: 'number' }).notNull().default(0),
    delta_spent_units: bigint('delta_spent_units', { mode: 'number' }).notNull().default(0),
    reserved_units_after: bigint('reserved_units_after', { mode: 'number' }).notNull(),
    spent_units_after: bigint('spent_units_after', { mode: 'number' }).notNull(),
    metadata: json<Record<string, unknown>>('metadata', {}),
    created_at: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_budget_ledger_account_operation').on(table.account_id, table.operation_key),
    index('idx_budget_ledger_account_created').on(table.account_id, table.created_at),
    index('idx_budget_ledger_reservation').on(table.reservation_id),
    index('idx_budget_ledger_created').on(table.created_at),
    oneOf('chk_budget_ledger_entry_type', table.entry_type, LEDGER_ENTRY_TYPES),
    check('chk_budget_ledger_balances', sql`${table.reserved_units_after} >= 0 AND ${table.spent_units_after} >= 0`),
  ],
);

export const PRICE_KINDS = ['model', 'service'] as const;

/**
 * Prices a super set on Services & pricing, overriding models.yaml /
 * services.yaml. Token rates are USD per 1M tokens; `unit_price` is USD per
 * call / image / minute.
 */
export const prices = pgTable(
  'prices',
  {
    id: id(),
    kind: text('kind', { enum: PRICE_KINDS }).notNull(),
    target: text('target').notNull(),
    provider: text('provider').notNull().default(''),
    input_per_mtok: doublePrecision('input_per_mtok'),
    output_per_mtok: doublePrecision('output_per_mtok'),
    cached_input_per_mtok: doublePrecision('cached_input_per_mtok'),
    unit_price: doublePrecision('unit_price'),
    updated_by: text('updated_by'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_prices_target').on(table.kind, table.target, table.provider),
    oneOf('chk_prices_kind', table.kind, PRICE_KINDS),
    check(
      'chk_prices_nonnegative',
      sql`COALESCE(${table.input_per_mtok}, 0) >= 0 AND COALESCE(${table.output_per_mtok}, 0) >= 0 AND COALESCE(${table.cached_input_per_mtok}, 0) >= 0 AND COALESCE(${table.unit_price}, 0) >= 0`,
    ),
  ],
);

export const MODULE_USAGE_KINDS = ['tool_call', 'page_open'] as const;

/**
 * Daily counts of what gets used (no content, no arguments, no per-member rows):
 * one row per (day, kind, key, client), upserted `count = count + 1`.
 */
export const moduleUsageDaily = pgTable(
  'module_usage_daily',
  {
    day: day('day').notNull(),
    kind: text('kind', { enum: MODULE_USAGE_KINDS }).notNull(),
    key: text('key').notNull(),
    client: text('client').notNull(),
    count: integer('count').notNull().default(0),
    updated_at: updatedAt(),
  },
  (table) => [
    primaryKey({ name: 'pk_module_usage_daily', columns: [table.day, table.kind, table.key, table.client] }),
    index('idx_module_usage_daily_kind_day').on(table.kind, table.day),
    oneOf('chk_module_usage_daily_kind', table.kind, MODULE_USAGE_KINDS),
  ],
);

export type UsageEventRow = typeof usageEvents.$inferSelect;
export type UsageEventKind = UsageEventRow['kind'];
export type BudgetRow = typeof budgets.$inferSelect;
export type UsageBudgetScopeType = BudgetRow['scope_type'];
export type UsageBudgetUnit = BudgetRow['unit'];
export type UsageBudgetAccountStatus = BudgetRow['status'];
export type UsageBudgetReservationRow = typeof budgetReservations.$inferSelect;
export type UsageBudgetReservationStatus = UsageBudgetReservationRow['status'];
export type UsageBudgetLedgerRow = typeof budgetLedger.$inferSelect;
export type UsageBudgetLedgerEntryType = UsageBudgetLedgerRow['entry_type'];
export type UsagePriceOverrideRow = typeof prices.$inferSelect;
export type UsageCounterRow = typeof moduleUsageDaily.$inferSelect;
export const USAGE_COUNTER_KINDS = MODULE_USAGE_KINDS;
