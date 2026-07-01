/**
 * Drizzle schema — Custom user-created Agent profiles.
 *
 * Design: a thin relational shell (the queryable/indexable columns) plus a
 * single `data` jsonb column holding the rest of the profile manifest
 * (`ProfileData` from @greenhouse/types/profile-manifest). Adding a new
 * configurable field = add it to the manifest schema; NO migration.
 *
 * Tables: custom_profiles
 */

import { pgTable, serial, text, boolean, timestamp, jsonb, index, unique } from 'drizzle-orm/pg-core';
import type { ProfileData } from '@greenhouse/types/profile-manifest';
import { users } from './user.js';

// ─── custom_profiles ──────────────────────────────────────

export const customProfiles = pgTable(
  'custom_profiles',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull(), // user-scoped unique, e.g. 'my-researcher'
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // display name (kept as a column for listing/sort)
    base_profile_id: text('base_profile_id').notNull().default('default'), // 'default' | 'team'
    is_shared: boolean('is_shared').notNull().default(false), // shared with all internal users
    forked_from: text('forked_from'), // source profile id: 'team' | 'custom:42' | null
    /**
     * The profile manifest payload (everything except the relational columns):
     * description, system_prompt, tools, capabilities, max_steps, tool_choice,
     * avatar, model_options, model_choice_ids, default_language, greeting,
     * suggested_followups. Typed by ProfileData — the single source of truth.
     */
    data: jsonb('data').$type<ProfileData>().notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    unique('uq_custom_profiles_user_slug').on(table.user_id, table.slug),
    index('idx_custom_profiles_user').on(table.user_id),
    index('idx_custom_profiles_shared').on(table.is_shared),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type CustomProfileRow = typeof customProfiles.$inferSelect;
