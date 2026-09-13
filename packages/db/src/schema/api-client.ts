/**
 * Drizzle schema — internal integration credentials & audit tables (PostgreSQL).
 *
 * Tables: api_clients, api_audit_log
 */

import { pgTable, text, serial, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { users } from './user.js';

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
    rate_limit_rpm: integer('rate_limit_rpm').notNull().default(60),
    rate_limit_rpd: integer('rate_limit_rpd').notNull().default(1000),
    daily_token_limit: integer('daily_token_limit').notNull().default(1000000),
    meta: text('meta').notNull().default('{}'),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['a2a', 'relay'] })
      .notNull()
      .default('a2a'),
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
    user_id: text('user_id'),
    // `api` is read-only legacy data from the removed public v1 surface.
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

export type ApiClientRow = typeof apiClients.$inferSelect;
export type ApiClientStatus = ApiClientRow['status'];
export type ApiClientChannel = ApiClientRow['channel'];
export type ApiAuditLogRow = typeof apiAuditLog.$inferSelect;
export type ApiAuditChannel = ApiAuditLogRow['channel'];
