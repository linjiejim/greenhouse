/**
 * Drizzle schema — User session groups (folders) + Pinned (PostgreSQL).
 *
 * Tables: session_groups, session_group_members
 *
 * A per-user, folder-like organization layer over the shared `sessions` table.
 * Each user privately groups any session they can SEE (own OR shared-with-me),
 * so two users grouping the same shared session keep fully independent rows.
 *
 * "Pinned" is modelled as a built-in system group (`kind = 'pinned'`,
 * auto-provisioned per user). Folders are single-home (a session lives in at
 * most one custom group per user — enforced in the service layer); pinned is
 * cross-cutting, so a session can be both pinned and in one folder.
 */

import { pgTable, serial, text, integer, timestamp, index, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { sessions } from './session.js';

// ─── session_groups ───────────────────────────────────────

export const sessionGroups = pgTable(
  'session_groups',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id').notNull(),
    name: text('name').notNull(),
    color: text('color').notNull().default('#6B7280'),
    icon: text('icon'),
    // 'custom' = user folder | 'pinned' = built-in system group (one per user)
    kind: text('kind').notNull().default('custom'),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_session_groups_user').on(table.user_id),
    unique('uq_session_groups_user_name').on(table.user_id, table.name),
  ],
);

// ─── session_group_members ────────────────────────────────

export const sessionGroupMembers = pgTable(
  'session_group_members',
  {
    id: serial('id').primaryKey(),
    user_id: text('user_id').notNull(),
    group_id: integer('group_id')
      .notNull()
      .references(() => sessionGroups.id, { onDelete: 'cascade' }),
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // Denormalized from the owning group ('custom' | 'pinned'), immutable once
    // set — lets the DB enforce single-home for custom folders (partial index).
    kind: text('kind').notNull().default('custom'),
    sort_order: integer('sort_order').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_session_group_members_user').on(table.user_id),
    index('idx_session_group_members_group').on(table.group_id),
    index('idx_session_group_members_session').on(table.session_id),
    // A session can have at most one membership per group (pinned + one folder = two rows).
    unique('uq_session_group_members').on(table.user_id, table.group_id, table.session_id),
    // Single-home: at most one custom-folder membership per (user, session).
    uniqueIndex('uq_session_group_members_single_home')
      .on(table.user_id, table.session_id)
      .where(sql`${table.kind} = 'custom'`),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type SessionGroupRow = typeof sessionGroups.$inferSelect;
export type SessionGroupMemberRow = typeof sessionGroupMembers.$inferSelect;
