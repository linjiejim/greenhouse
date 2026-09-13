/**
 * Drizzle schema — Custom user-created Agent profiles.
 *
 * Tables: custom_profiles, custom_profile_versions
 */

import { pgTable, serial, text, integer, boolean, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { users } from './user.js';

export const CUSTOM_PROFILE_LIFECYCLE_STATUSES = [
  'draft',
  'review',
  'pilot',
  'verified',
  'rejected',
  'suspended',
  'deprecated',
  'archived',
] as const;

export const CUSTOM_PROFILE_RISK_LEVELS = ['low', 'medium', 'high'] as const;

// ─── custom_profiles ──────────────────────────────────────

export const customProfiles = pgTable(
  'custom_profiles',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull(), // user-scoped unique, e.g. 'my-researcher'
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // display name, e.g. '我的调研助手'
    description: text('description'),
    /** Fork lineage only — the model lives on this row (see model_id). */
    base_profile_id: text('base_profile_id').notNull().default('team'),
    /**
     * Registry model id this agent is pinned to. Null for rows created before
     * agents owned their model; those resolve through the base preset.
     */
    model_id: text('model_id'),
    tools: text('tools').notNull().default('[]'), // JSON array of tool IDs
    system_prompt: text('system_prompt').notNull(),
    max_steps: integer('max_steps').notNull().default(12),
    is_shared: boolean('is_shared').notNull().default(false), // shared with all internal users
    avatar: text('avatar').notNull().default('{}'), // JSON: {color, accessories, leafStyle, eyeStyle, faceStyle}
    forked_from: text('forked_from'), // source profile id: 'researcher' | 'custom:42' | null
    /** Latest immutable manifest version visible to the owner/editor. */
    current_version: integer('current_version').notNull().default(1),
    /** Reviewed version exposed to non-owners while lifecycle is pilot/verified. */
    published_version: integer('published_version'),
    lifecycle_status: text('lifecycle_status', { enum: CUSTOM_PROFILE_LIFECYCLE_STATUSES }).notNull().default('draft'),
    lifecycle_note: text('lifecycle_note'),
    /** Backup owner for operational continuity; ownership transfer stays explicit. */
    owner_backup_user_id: text('owner_backup_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Reviewer references are deliberately loose so lifecycle history survives account disablement. */
    reviewed_by: text('reviewed_by'),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true, mode: 'string' }),
    next_review_at: timestamp('next_review_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    unique('uq_custom_profiles_user_slug').on(table.user_id, table.slug),
    index('idx_custom_profiles_user').on(table.user_id),
    index('idx_custom_profiles_shared').on(table.is_shared),
    index('idx_custom_profiles_lifecycle').on(table.lifecycle_status),
    index('idx_custom_profiles_backup_owner').on(table.owner_backup_user_id),
  ],
);

// ─── custom_profile_versions ──────────────────────────────

/**
 * Immutable executable manifests. There is intentionally no update/delete
 * service: editing an Agent appends a row and advances custom_profiles.current_version.
 */
export const customProfileVersions = pgTable(
  'custom_profile_versions',
  {
    id: serial('id').primaryKey(),
    profile_id: integer('profile_id')
      .notNull()
      .references(() => customProfiles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    manifest_hash: text('manifest_hash').notNull(),
    change_log: text('change_log').notNull().default(''),
    name: text('name').notNull(),
    description: text('description'),
    base_profile_id: text('base_profile_id').notNull().default('team'),
    model_id: text('model_id'),
    tools: text('tools').notNull().default('[]'),
    system_prompt: text('system_prompt').notNull(),
    max_steps: integer('max_steps').notNull().default(12),
    avatar: text('avatar').notNull().default('{}'),
    /** Governance metadata is versioned with the executable manifest. */
    purpose: text('purpose'),
    audience: text('audience'),
    risk_level: text('risk_level', { enum: CUSTOM_PROFILE_RISK_LEVELS }).notNull().default('medium'),
    budget_policy: text('budget_policy').notNull().default('{}'),
    eval_refs: text('eval_refs').notNull().default('[]'),
    /** Snapshot only: no FK, otherwise deleting a user would mutate this immutable row. */
    owner_backup_user_id: text('owner_backup_user_id'),
    review_due_at: timestamp('review_due_at', { withTimezone: true, mode: 'string' }),
    created_by: text('created_by'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    unique('uq_custom_profile_versions_profile_version').on(table.profile_id, table.version),
    index('idx_custom_profile_versions_profile_hash').on(table.profile_id, table.manifest_hash),
    index('idx_custom_profile_versions_profile').on(table.profile_id),
    index('idx_custom_profile_versions_created').on(table.created_at),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type CustomProfileRow = typeof customProfiles.$inferSelect;
export type CustomProfileVersionRow = typeof customProfileVersions.$inferSelect;
export type CustomProfileLifecycleStatus = CustomProfileRow['lifecycle_status'];
export type CustomProfileRiskLevel = CustomProfileVersionRow['risk_level'];
