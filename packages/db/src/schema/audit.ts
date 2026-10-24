/**
 * Audit: one append-only stream of who changed what, and the request log of
 * machine callers.
 *
 * Tables: audit_events, request_log
 *
 * `audit_events` is what the Activity log reads: platform actions (people,
 * their agents, admins, drive writes), project / task activity (app_id =
 * 'projects') and outgoing mail (app_id = 'email', action_id = 'send'; the
 * daily send limit counts its `success` rows). It records who acted on whose
 * behalf, on what, and the outcome — never content or secrets. Every subject is
 * a logical reference so the record outlives it.
 *
 * `request_log` records MCP (`a2a`) and agent-proxy (`cli`) calls; kept 30
 * days (`retention.ts`).
 */

import { index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, id, json, oneOf } from './_columns.js';

export const AUDIT_ACTOR_TYPES = ['human', 'agent', 'service', 'system', 'migration'] as const;
export const AUDIT_RESULTS = ['success', 'denied', 'error'] as const;

export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    actor_id: text('actor_id').notNull(),
    actor_type: text('actor_type', { enum: AUDIT_ACTOR_TYPES }).notNull(),
    on_behalf_of_user_id: text('on_behalf_of_user_id'),
    client_id: text('client_id'),
    request_id: text('request_id').notNull(),
    app_id: text('app_id').notNull(),
    module_id: text('module_id'),
    entity_id: text('entity_id'),
    record_id: text('record_id'),
    action_id: text('action_id').notNull(),
    capability: text('capability').notNull(),
    result: text('result', { enum: AUDIT_RESULTS }).notNull(),
    summary: json<Record<string, unknown>>('summary', {}),
    created_at: createdAt(),
  },
  (table) => [
    index('idx_audit_events_created').on(table.created_at),
    index('idx_audit_events_actor_created').on(table.actor_id, table.created_at),
    index('idx_audit_events_resource_created').on(table.app_id, table.entity_id, table.record_id, table.created_at),
    index('idx_audit_events_app_action_created').on(table.app_id, table.action_id, table.created_at),
    index('idx_audit_events_request').on(table.request_id),
    oneOf('chk_audit_events_actor_type', table.actor_type, AUDIT_ACTOR_TYPES),
    oneOf('chk_audit_events_result', table.result, AUDIT_RESULTS),
  ],
);

export const REQUEST_CHANNELS = ['api', 'a2a', 'cli', 'relay'] as const;

export const requestLog = pgTable(
  'request_log',
  {
    id: id(),
    app_id: text('app_id').notNull(),
    endpoint: text('endpoint').notNull(),
    method: text('method').notNull(),
    user_id: text('user_id'),
    /** New rows are `a2a` (MCP) or `cli` (agent proxy); `api` / `relay` are carried history. */
    channel: text('channel', { enum: REQUEST_CHANNELS }).notNull().default('a2a'),
    status_code: integer('status_code'),
    duration_ms: integer('duration_ms'),
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    meta: json<Record<string, unknown>>('meta', {}),
    ip_address: text('ip_address'),
    error: text('error'),
    created_at: createdAt(),
  },
  (table) => [
    index('idx_request_log_app').on(table.app_id),
    index('idx_request_log_created').on(table.created_at),
    index('idx_request_log_user').on(table.user_id, table.created_at),
    oneOf('chk_request_log_channel', table.channel, REQUEST_CHANNELS),
  ],
);

export type PlatformAuditEventRow = typeof auditEvents.$inferSelect;
export type ApiAuditLogRow = typeof requestLog.$inferSelect;
export type ApiAuditChannel = ApiAuditLogRow['channel'];
