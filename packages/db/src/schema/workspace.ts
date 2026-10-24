/**
 * Workspace-wide state: admin-editable deployment settings and the extension
 * migration lane's bookkeeping.
 *
 * Tables: workspace_settings, extension_migrations
 */

import { jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { at, updatedAt } from './_columns.js';

/** Registry: WORKSPACE_SETTINGS in @greenhouse/types. Secrets go to `value_enc`, never `value`. */
export const workspaceSettings = pgTable('workspace_settings', {
  key: text('key').primaryKey(),
  /** Plain value; null for secrets. */
  value: jsonb('value'),
  /** Encrypted JSON string; null for plain values. */
  value_enc: text('value_enc'),
  updated_by: text('updated_by'),
  updated_at: updatedAt(),
});

/** One row per applied extension migration file, checksummed (`extension-migrations.ts`). */
export const extensionMigrations = pgTable(
  'extension_migrations',
  {
    extension_id: text('extension_id').notNull(),
    name: text('name').notNull(),
    checksum: text('checksum').notNull(),
    applied_at: at('applied_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.extension_id, table.name] })],
);

export type WorkspaceSettingRow = typeof workspaceSettings.$inferSelect;
