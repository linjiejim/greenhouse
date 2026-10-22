/**
 * Drizzle schema — internal integration audit (PostgreSQL).
 *
 * Tables: api_audit_log — written by MCP (`recordMcpAudit`, channel `a2a`) and the
 * Agent proxy (`recordAgentAudit`, channel `cli`). `api` and `relay` rows are
 * read-only history from removed surfaces. `app_id` is a logical reference
 * (OAuth client id / `agent:<user>`); it never had a FK.
 */

import { pgTable, text, serial, timestamp, integer, index } from 'drizzle-orm/pg-core';

// ─── api_audit_log ────────────────────────────────────────

export const apiAuditLog = pgTable(
  'api_audit_log',
  {
    id: serial('id').primaryKey(),
    app_id: text('app_id').notNull(),
    endpoint: text('endpoint').notNull(),
    method: text('method').notNull(),
    user_id: text('user_id'),
    // `api` (public v1 surface) and `relay` (LLM relay, removed in v1.4) are read-only history.
    channel: text('channel', { enum: ['api', 'a2a', 'cli', 'relay'] })
      .notNull()
      .default('a2a'),
    status_code: integer('status_code'),
    duration_ms: integer('duration_ms'),
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    meta: text('meta').notNull().default('{}'),
    ip_address: text('ip_address'),
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_api_audit_app').on(table.app_id),
    index('idx_api_audit_created').on(table.created_at),
    index('idx_api_audit_user').on(table.user_id),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type ApiAuditLogRow = typeof apiAuditLog.$inferSelect;
export type ApiAuditChannel = ApiAuditLogRow['channel'];
