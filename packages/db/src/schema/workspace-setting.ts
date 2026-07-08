/**
 * Drizzle schema — Workspace settings (DB-backed, admin-editable deployment config).
 *
 * One row per configured registry key (`WORKSPACE_SETTINGS` in
 * @greenhouse/types/workspace-settings); unset keys have no row. Plain values
 * live in `value` (jsonb); secret values live AES-256-GCM-encrypted in
 * `value_enc` (same PROVIDER_TOKEN_ENCRYPTION_KEY path as llm_upstreams).
 * Exactly one of the two columns is non-null per row.
 *
 * Tables: workspace_settings
 */

import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

// ─── workspace_settings ───────────────────────────────────

export const workspaceSettings = pgTable('workspace_settings', {
  key: text('key').primaryKey(), // registry key, e.g. 'llm.api_key'
  value: jsonb('value'), // plain value (NULL for secrets)
  value_enc: text('value_enc'), // encrypted JSON string (NULL for plain values)
  updated_by: text('updated_by'),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});

// ─── Row types (inferred — schema is the single source of truth) ──

export type WorkspaceSettingRow = typeof workspaceSettings.$inferSelect;
