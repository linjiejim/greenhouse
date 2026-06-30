/**
 * Drizzle schema — User groups (PostgreSQL).
 *
 * Tables: user_groups, group_members
 *
 * Lightweight, user-created groups ("小组") used as sharing targets for the
 * knowledge base (and reusable elsewhere). A group is owned by its creator;
 * the owner (and super) manage membership. Sharing a doc with a group is
 * expressed as a knowledge_base_shares row with shared_with='group:<id>'.
 */

import { pgTable, serial, text, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './user.js';

// ─── user_groups ──────────────────────────────────────────

export const userGroups = pgTable(
  'user_groups',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    created_by: text('created_by').notNull(), // group owner (manages membership)
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_user_groups_creator').on(table.created_by)],
);

// ─── group_members ────────────────────────────────────────

export const groupMembers = pgTable(
  'group_members',
  {
    id: serial('id').primaryKey(),
    group_id: integer('group_id')
      .notNull()
      .references(() => userGroups.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    added_by: text('added_by'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_group_members_group_user').on(table.group_id, table.user_id),
    index('idx_group_members_user').on(table.user_id),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type UserGroupRow = typeof userGroups.$inferSelect;
export type GroupMemberRow = typeof groupMembers.$inferSelect;
