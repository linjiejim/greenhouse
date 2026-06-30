/**
 * Drizzle schema — Feature requests table (PostgreSQL).
 *
 * Tables: feature_requests
 */

import { pgTable, text, serial, timestamp } from 'drizzle-orm/pg-core';

export const featureRequests = pgTable('feature_requests', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  submitted_by: text('submitted_by').notNull(),
  status: text('status', { enum: ['pending', 'accepted', 'rejected', 'done'] })
    .notNull()
    .default('pending'),
  priority: text('priority', { enum: ['low', 'normal', 'high'] })
    .notNull()
    .default('normal'),
  admin_note: text('admin_note'),
  session_id: text('session_id'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});

// ─── Row types (inferred — schema is the single source of truth) ──

export type FeatureRequestRow = typeof featureRequests.$inferSelect;
export type FeatureRequestStatus = FeatureRequestRow['status'];
export type FeatureRequestPriority = FeatureRequestRow['priority'];
