import { bigint, boolean, index, integer, numeric, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id } from './_columns.js';

/** One row per provider call: the only fact for usage and cost. */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    capability: text('capability').notNull(),
    providerId: text('provider_id').notNull(),
    source: text('source', { enum: ['env', 'workspace', 'personal', 'builtin'] }).notNull(),
    memberId: text('member_id'),
    agentId: text('agent_id'),
    runId: text('run_id'),
    conversationId: text('conversation_id'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedTokens: integer('cached_tokens'),
    quantity: numeric('quantity', { mode: 'number' }),
    unit: text('unit'),
    costMicros: bigint('cost_micros', { mode: 'number' }),
    /** The outcome was unknown, so the reserved estimate was charged. */
    estimated: boolean('estimated').notNull().default(false),
    budgetKey: text('budget_key'),
    createdAt: createdAt(),
  },
  (t) => [
    index('usage_events_member_idx').on(t.memberId, t.createdAt),
    index('usage_events_provider_idx').on(t.providerId, t.createdAt),
  ],
);

export const BUDGET_SCOPES = ['workspace', 'provider', 'member', 'agent', 'field'] as const;

export const budgets = pgTable(
  'budgets',
  {
    id: id(),
    scopeType: text('scope_type', { enum: BUDGET_SCOPES }).notNull(),
    scopeId: text('scope_id').notNull(),
    unit: text('unit', { enum: ['tokens', 'usd_micros'] }).notNull(),
    monthlyLimit: bigint('monthly_limit', { mode: 'number' }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('budgets_scope_key').on(t.scopeType, t.scopeId, t.unit)],
);

/** Counters per budget and UTC month; a cache of usage_events, never the truth. */
export const budgetPeriods = pgTable(
  'budget_periods',
  {
    budgetId: text('budget_id').notNull(),
    periodStart: at('period_start').notNull(),
    periodEnd: at('period_end').notNull(),
    reserved: bigint('reserved', { mode: 'number' }).notNull().default(0),
    spent: bigint('spent', { mode: 'number' }).notNull().default(0),
    version: integer('version').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.budgetId, t.periodStart] })],
);

export const budgetReservations = pgTable(
  'budget_reservations',
  {
    id: id(),
    budgetId: text('budget_id').notNull(),
    periodStart: at('period_start').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    estimated: bigint('estimated', { mode: 'number' }).notNull(),
    actual: bigint('actual', { mode: 'number' }),
    status: text('status', { enum: ['reserved', 'settled', 'released', 'expired'] })
      .notNull()
      .default('reserved'),
    expiresAt: at('expires_at').notNull(),
    memberId: text('member_id'),
    runId: text('run_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('budget_reservations_key').on(t.budgetId, t.idempotencyKey)],
);

/** The only audit table: who did what to which object, on whose behalf. No content, no secrets. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    actorType: text('actor_type', { enum: ['member', 'agent', 'client', 'system'] }).notNull(),
    actorId: text('actor_id'),
    onBehalfOf: text('on_behalf_of'),
    agentId: text('agent_id'),
    clientId: text('client_id'),
    requestId: text('request_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    scopeType: text('scope_type'),
    scopeId: text('scope_id'),
    result: text('result', { enum: ['success', 'denied', 'error'] }).notNull(),
    summary: text('summary').notNull().default(''),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_events_actor_idx').on(t.actorType, t.actorId, t.createdAt),
    index('audit_events_resource_idx').on(t.resourceType, t.resourceId),
  ],
);

export type UsageEventRow = typeof usageEvents.$inferSelect;
export type BudgetRow = typeof budgets.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
