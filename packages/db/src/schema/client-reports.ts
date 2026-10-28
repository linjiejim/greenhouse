/**
 * Client error reports: errors the universal client caught (or a launch it saw end uncleanly),
 * sent by members to their station and read by supers in Administration › Client errors.
 *
 * Tables: client_reports
 *
 * - Telemetry: `user_id` is a logical reference (no FK); a report outlives nothing and is kept
 *   90 days, at most 10,000 rows (`retention.ts`).
 * - Text columns hold redacted text only (`@greenhouse/types/client-reports`): no message bodies,
 *   document text, credentials or URL queries.
 * - `client_report_id` is the device's id for the report; a resend is stored once per member.
 * - `fingerprint` groups reports by name and normalized message.
 */

import { boolean, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, oneOf } from './_columns.js';

// The vocabulary of `@greenhouse/types/client-reports` (drizzle-kit loads schema files without the
// workspace's ESM exports); the service's typed insert keeps the two in step.
const SOURCES = ['global', 'promise', 'boundary', 'window', 'unclean_exit'] as const;
const PLATFORMS = ['ios', 'android', 'web', 'desktop'] as const;

export const clientReports = pgTable(
  'client_reports',
  {
    id: id(),
    user_id: text('user_id').notNull(),
    client_report_id: text('client_report_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    fatal: boolean('fatal').notNull(),
    source: text('source', { enum: SOURCES }).notNull(),
    name: text('name').notNull(),
    message: text('message').notNull(),
    stack: text('stack'),
    route: text('route'),
    platform: text('platform', { enum: PLATFORMS }).notNull(),
    os_version: text('os_version'),
    app_version: text('app_version'),
    app_build: text('app_build'),
    api_level: integer('api_level'),
    occurred_at: at('occurred_at').notNull(),
    created_at: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_client_reports_user_client_id').on(table.user_id, table.client_report_id),
    index('idx_client_reports_created_at').on(table.created_at),
    index('idx_client_reports_fingerprint_created_at').on(table.fingerprint, table.created_at),
    oneOf('chk_client_reports_source', table.source, SOURCES),
    oneOf('chk_client_reports_platform', table.platform, PLATFORMS),
  ],
);

export type ClientReportRow = typeof clientReports.$inferSelect;
