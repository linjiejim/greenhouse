/**
 * Drizzle schema — API client & audit tables (PostgreSQL).
 *
 * Tables: api_clients, api_audit_log
 */

import { pgTable, text, serial, timestamp, integer, index } from 'drizzle-orm/pg-core';

// ─── api_clients ──────────────────────────────────────────

export const apiClients = pgTable(
  'api_clients',
  {
    id: text('id').primaryKey(),
    app_id: text('app_id').notNull().unique(),
    app_name: text('app_name').notNull(),
    api_key_hash: text('api_key_hash').notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    allowed_profiles: text('allowed_profiles').notNull().default('[]'),
    rate_limit_rpm: integer('rate_limit_rpm').notNull().default(60),
    rate_limit_rpd: integer('rate_limit_rpd').notNull().default(1000),
    daily_token_limit: integer('daily_token_limit').notNull().default(1000000),
    meta: text('meta').notNull().default('{}'),
    user_id: text('user_id'), // A2A: 关联内部用户 (nullable=系统级Key)
    channel: text('channel', { enum: ['api', 'a2a', 'local-agent', 'cli', 'relay'] })
      .notNull()
      .default('api'),
    created_by: text('created_by'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_api_clients_user').on(table.user_id)],
);

// ─── api_audit_log ────────────────────────────────────────

export const apiAuditLog = pgTable(
  'api_audit_log',
  {
    id: serial('id').primaryKey(),
    app_id: text('app_id').notNull(),
    endpoint: text('endpoint').notNull(),
    method: text('method').notNull(),
    session_id: text('session_id'),
    ext_user_id: text('ext_user_id'),
    user_id: text('user_id'), // A2A: 内部用户 ID
    channel: text('channel').notNull().default('api'), // 'api' | 'a2a'
    a2a_task_id: text('a2a_task_id'), // A2A task tracking
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

export type ApiClientRow = typeof apiClients.$inferSelect;
export type ApiClientStatus = ApiClientRow['status'];
export type ApiClientChannel = ApiClientRow['channel'];
export type ApiAuditLogRow = typeof apiAuditLog.$inferSelect;
