/**
 * Drizzle schema — Custom user-created Agent profiles.
 *
 * Tables: custom_profiles
 */

import { pgTable, serial, text, integer, boolean, timestamp, index, unique } from 'drizzle-orm/pg-core';
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
    name: text('name').notNull(), // display name, e.g. '我的调研助手'
    description: text('description'),
    base_profile_id: text('base_profile_id').notNull().default('default'), // 'default' | 'team'
    tools: text('tools').notNull().default('[]'), // JSON array of tool IDs
    system_prompt: text('system_prompt').notNull(),
    capabilities: text('capabilities').notNull().default('[]'), // JSON array of {icon,label,prompt}
    max_steps: integer('max_steps').notNull().default(12),
    is_shared: boolean('is_shared').notNull().default(false), // shared with all internal users
    avatar: text('avatar').notNull().default('{}'), // JSON: {color, accessories, leafStyle, faceStyle}
    forked_from: text('forked_from'), // source profile id: 'researcher' | 'custom:42' | null
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
