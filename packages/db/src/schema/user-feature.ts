/**
 * Drizzle schema — User feature gate (PostgreSQL).
 *
 * Tables: user_features
 *
 * Generic per-user feature toggle system.
 * Super admins can enable/disable features for individual users.
 * Phase 1 usage: 'memory' feature for AI agent memory.
 * Future: any experimental/beta feature rollout.
 */

import { pgTable, serial, text, timestamp, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './user.js';

// ─── user_features ────────────────────────────────────────

export const userFeatures = pgTable(
  'user_features',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    feature: text('feature').notNull(), // 'memory' | 'beta_xxx' | ...
    enabled: boolean('enabled').notNull().default(true),
    config: text('config').notNull().default('{}'), // JSON — feature-level params
    granted_by: text('granted_by'), // super admin user ID
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_user_feature').on(table.user_id, table.feature),
    index('idx_user_features_feature').on(table.feature),
  ],
);
