/**
 * Drizzle schema — LLM Usage tracking table (PostgreSQL).
 *
 * Tables: llm_usage, usage_budget_accounts, usage_budget_reservations,
 * usage_budget_ledger
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const llmUsage = pgTable(
  'llm_usage',
  {
    id: serial('id').primaryKey(),
    profile_id: text('profile_id').notNull(),
    caller: text('caller').notNull().default(''),
    session_id: text('session_id'),
    user_id: text('user_id'),
    model: text('model').notNull(),
    input_tokens: integer('input_tokens').notNull().default(0),
    output_tokens: integer('output_tokens').notNull().default(0),
    cached_tokens: integer('cached_tokens').notNull().default(0),
    reasoning_tokens: integer('reasoning_tokens').notNull().default(0),
    duration_ms: integer('duration_ms'),
    /** Logical link to the budget reservation; null means legacy/unbudgeted usage. */
    budget_idempotency_key: text('budget_idempotency_key'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_llm_usage_profile').on(table.profile_id),
    index('idx_llm_usage_created').on(table.created_at),
    index('idx_llm_usage_caller').on(table.caller),
    index('idx_llm_usage_user').on(table.user_id),
    index('idx_llm_usage_budget_key').on(table.budget_idempotency_key),
  ],
);

// ─── Unified usage budgets ─────────────────────────────

/**
 * One hard-limit account for one scope and one half-open accounting period.
 *
 * Scope references are intentionally logical: this polymorphic control-plane
 * record and its ledger must outlive a deleted user, Agent, provider binding,
 * or organization. The service never physically deletes an account.
 */
export const usageBudgetAccounts = pgTable(
  'usage_budget_accounts',
  {
    id: text('id').primaryKey(),
    scope_type: text('scope_type', {
      enum: ['user', 'organization', 'agent', 'run', 'eval', 'provider'],
    }).notNull(),
    scope_id: text('scope_id').notNull(),
    unit: text('unit', { enum: ['tokens', 'requests', 'usd_micros'] })
      .notNull()
      .default('tokens'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    /** Inclusive period start. */
    period_start: timestamp('period_start', { withTimezone: true, mode: 'string' }).notNull(),
    /** Exclusive period end. */
    period_end: timestamp('period_end', { withTimezone: true, mode: 'string' }).notNull(),
    limit_units: bigint('limit_units', { mode: 'number' }).notNull(),
    reserved_units: bigint('reserved_units', { mode: 'number' }).notNull().default(0),
    spent_units: bigint('spent_units', { mode: 'number' }).notNull().default(0),
    /** Portion of spent_units projected from unlinked legacy llm_usage rows. */
    legacy_spent_units: bigint('legacy_spent_units', { mode: 'number' }).notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_usage_budget_account_scope_period').on(
      table.scope_type,
      table.scope_id,
      table.unit,
      table.period_start,
      table.period_end,
    ),
    index('idx_usage_budget_accounts_scope').on(table.scope_type, table.scope_id, table.status),
    index('idx_usage_budget_accounts_period').on(table.period_start, table.period_end),
    check('chk_usage_budget_accounts_period', sql`${table.period_end} > ${table.period_start}`),
    check(
      'chk_usage_budget_accounts_nonnegative',
      sql`${table.limit_units} >= 0 AND ${table.reserved_units} >= 0 AND ${table.spent_units} >= 0 AND ${table.legacy_spent_units} >= 0 AND ${table.legacy_spent_units} <= ${table.spent_units}`,
    ),
  ],
);

/**
 * One row per account charged by a logical model invocation. Rows sharing an
 * idempotency_key are one reservation group, so a call can atomically debit
 * user + organization + Agent + Eval + provider budgets without a join table.
 */
export const usageBudgetReservations = pgTable(
  'usage_budget_reservations',
  {
    id: text('id').primaryKey(),
    account_id: text('account_id').notNull(),
    idempotency_key: text('idempotency_key').notNull(),
    /** Hash of the immutable reservation request; detects key reuse drift. */
    request_hash: text('request_hash').notNull(),
    status: text('status', { enum: ['reserved', 'settled', 'released', 'expired'] })
      .notNull()
      .default('reserved'),
    estimated_units: bigint('estimated_units', { mode: 'number' }).notNull(),
    actual_units: bigint('actual_units', { mode: 'number' }),
    caller: text('caller').notNull(),
    user_id: text('user_id'),
    run_id: text('run_id'),
    provider_id: text('provider_id'),
    model_id: text('model_id'),
    metadata: text('metadata').notNull().default('{}'),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    settled_at: timestamp('settled_at', { withTimezone: true, mode: 'string' }),
    released_at: timestamp('released_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_usage_budget_reservation_account_key').on(table.account_id, table.idempotency_key),
    index('idx_usage_budget_reservations_key').on(table.idempotency_key),
    index('idx_usage_budget_reservations_status_expiry').on(table.status, table.expires_at),
    index('idx_usage_budget_reservations_user_created').on(table.user_id, table.created_at),
    index('idx_usage_budget_reservations_run').on(table.run_id),
    check('chk_usage_budget_reservations_estimate', sql`${table.estimated_units} > 0`),
    check('chk_usage_budget_reservations_actual', sql`${table.actual_units} IS NULL OR ${table.actual_units} >= 0`),
  ],
);

/**
 * Permanent append-only accounting history. account_id/reservation_id are
 * logical references on purpose: audit must survive every subject lifecycle.
 */
export const usageBudgetLedger = pgTable(
  'usage_budget_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    account_id: text('account_id').notNull(),
    reservation_id: text('reservation_id'),
    /** Per-account immutable transition key; prevents duplicate ledger effects. */
    operation_key: text('operation_key').notNull(),
    entry_type: text('entry_type', {
      enum: ['bootstrap', 'reconcile', 'reserve', 'settle', 'release', 'expire', 'adjustment', 'status'],
    }).notNull(),
    delta_reserved_units: bigint('delta_reserved_units', { mode: 'number' }).notNull().default(0),
    delta_spent_units: bigint('delta_spent_units', { mode: 'number' }).notNull().default(0),
    reserved_units_after: bigint('reserved_units_after', { mode: 'number' }).notNull(),
    spent_units_after: bigint('spent_units_after', { mode: 'number' }).notNull(),
    metadata: text('metadata').notNull().default('{}'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_usage_budget_ledger_account_operation').on(table.account_id, table.operation_key),
    index('idx_usage_budget_ledger_account_created').on(table.account_id, table.created_at),
    index('idx_usage_budget_ledger_reservation').on(table.reservation_id),
    check(
      'chk_usage_budget_ledger_balances',
      sql`${table.reserved_units_after} >= 0 AND ${table.spent_units_after} >= 0`,
    ),
  ],
);

export type UsageRow = typeof llmUsage.$inferSelect;
export type UsageBudgetAccountRow = typeof usageBudgetAccounts.$inferSelect;
export type UsageBudgetScopeType = UsageBudgetAccountRow['scope_type'];
export type UsageBudgetUnit = UsageBudgetAccountRow['unit'];
export type UsageBudgetAccountStatus = UsageBudgetAccountRow['status'];
export type UsageBudgetReservationRow = typeof usageBudgetReservations.$inferSelect;
export type UsageBudgetReservationStatus = UsageBudgetReservationRow['status'];
export type UsageBudgetLedgerRow = typeof usageBudgetLedger.$inferSelect;
export type UsageBudgetLedgerEntryType = UsageBudgetLedgerRow['entry_type'];
