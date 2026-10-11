/**
 * Drizzle schema — Apps (应用) built on a Tables Base (Tables → Apps Phase 1,
 * docs/specs/20261011-tables-apps.md §1).
 *
 * Tables: table_apps, table_app_versions, table_app_audiences, table_app_pins,
 *         table_app_action_requests
 *
 * An app belongs to one Base. Its draft spec is edited in place
 * (`draft_revision` CAS); publishing appends an immutable version whose spec is
 * stored as TEXT — the exact bytes that were hashed (jsonb would reorder keys
 * and the hash would no longer match, D7). Audiences point at a role key of the
 * published spec; one row per person, per group, and at most one team row.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { AppAccent, AppIconName, AppStatus } from '@greenhouse/types/apps';
import { userGroups } from './groups.js';
import { tableBases } from './tables.js';

export const tableApps = pgTable(
  'table_apps',
  {
    id: serial('id').primaryKey(),
    base_id: integer('base_id')
      .notNull()
      .references(() => tableBases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    icon: text('icon').$type<AppIconName>().notNull().default('app'),
    accent: text('accent').$type<AppAccent>().notNull().default('brand'),
    /** The person responsible (logical → users). Managing rights still come from the Base (D2). */
    owner_id: text('owner_id').notNull(),
    status: text('status', { enum: ['draft', 'published', 'archived'] })
      .$type<AppStatus>()
      .notNull()
      .default('draft'),
    /** The draft `AppSpec` as JSON text; parsed and validated by the API. */
    draft_spec: text('draft_spec').notNull(),
    draft_revision: integer('draft_revision').notNull().default(1),
    /** The live version number; null until the first publish. */
    published_version: integer('published_version'),
    audiences_revision: integer('audiences_revision').notNull().default(1),
    /** Recommended to its audience (super only). */
    featured: boolean('featured').notNull().default(false),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('idx_table_apps_base').on(table.base_id),
    index('idx_table_apps_owner').on(table.owner_id),
    index('idx_table_apps_featured')
      .on(table.id)
      .where(sql`${table.featured}`),
  ],
);

/** Immutable published versions. `spec` is the exact text `spec_hash` (sha256 hex) was computed over. */
export const tableAppVersions = pgTable(
  'table_app_versions',
  {
    id: serial('id').primaryKey(),
    app_id: integer('app_id')
      .notNull()
      .references(() => tableApps.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    spec: text('spec').notNull(),
    spec_hash: text('spec_hash').notNull(),
    /** The draft revision this version was published from. */
    draft_revision: integer('draft_revision').notNull(),
    notes: text('notes'),
    published_by: text('published_by').notNull(),
    published_at: timestamp('published_at', { withTimezone: true, mode: 'string' }).notNull(),
    /** Phase 2 (custom components): the reviewer's sign-off on the version's sandboxed code. Null until then. */
    custom_review: jsonb('custom_review').$type<Record<string, unknown>>(),
  },
  (table) => [uniqueIndex('uq_table_app_versions_app_version').on(table.app_id, table.version)],
);

/**
 * Who an app is shared with, and as which role. One row per person / group,
 * at most one team row per app; the "shared with me" lookups use the partial
 * indexes (the team lookup reads `uq_table_app_audiences_team`).
 */
export const tableAppAudiences = pgTable(
  'table_app_audiences',
  {
    id: serial('id').primaryKey(),
    app_id: integer('app_id')
      .notNull()
      .references(() => tableApps.id, { onDelete: 'cascade' }),
    principal_type: text('principal_type', { enum: ['user', 'group', 'team'] }).notNull(),
    /** principal_type = user (logical → users). */
    user_id: text('user_id'),
    /** principal_type = group; membership is `group_members` rows only. */
    group_id: integer('group_id').references(() => userGroups.id, { onDelete: 'cascade' }),
    /** A role key of the app's spec (a key the live version no longer has grants nothing). */
    role_key: text('role_key').notNull(),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    check(
      'chk_table_app_audiences_principal',
      sql`(${table.principal_type} = 'user' AND ${table.user_id} IS NOT NULL AND ${table.group_id} IS NULL)
        OR (${table.principal_type} = 'group' AND ${table.group_id} IS NOT NULL AND ${table.user_id} IS NULL)
        OR (${table.principal_type} = 'team' AND ${table.user_id} IS NULL AND ${table.group_id} IS NULL)`,
    ),
    uniqueIndex('uq_table_app_audiences_user')
      .on(table.app_id, table.user_id)
      .where(sql`${table.principal_type} = 'user'`),
    uniqueIndex('uq_table_app_audiences_group')
      .on(table.app_id, table.group_id)
      .where(sql`${table.principal_type} = 'group'`),
    uniqueIndex('uq_table_app_audiences_team')
      .on(table.app_id)
      .where(sql`${table.principal_type} = 'team'`),
    index('idx_table_app_audiences_user')
      .on(table.user_id)
      .where(sql`${table.principal_type} = 'user'`),
    index('idx_table_app_audiences_group')
      .on(table.group_id)
      .where(sql`${table.principal_type} = 'group'`),
  ],
);

/** A person's pinned apps, in their sidebar order (server-side, D9). */
export const tableAppPins = pgTable(
  'table_app_pins',
  {
    user_id: text('user_id').notNull(),
    app_id: integer('app_id')
      .notNull()
      .references(() => tableApps.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.user_id, table.app_id] }), index('idx_table_app_pins_app').on(table.app_id)],
);

/**
 * The app gateway's action ledger: one row per app write a person asked for,
 * keyed by their `requestId`. A repeated request replays the first result
 * instead of writing twice (`status = 'done'` keeps it); a request that was
 * refused leaves no row, so a retry runs again. The rows also count usage —
 * runs per action id in the managers' summary.
 */
export const tableAppActionRequests = pgTable(
  'table_app_action_requests',
  {
    id: serial('id').primaryKey(),
    app_id: integer('app_id')
      .notNull()
      .references(() => tableApps.id, { onDelete: 'cascade' }),
    /** Who asked (logical → users). */
    user_id: text('user_id').notNull(),
    /** The client's idempotency key. */
    request_id: text('request_id').notNull(),
    /** A spec action id, or `$submit` / `$create` / `$move` / `$edit`. */
    action_id: text('action_id').notNull(),
    page_id: text('page_id').notNull(),
    card_id: text('card_id').notNull(),
    record_id: integer('record_id'),
    status: text('status', { enum: ['running', 'done'] }).notNull(),
    /** The `AppActionResult` answered the first time (replayed as is). */
    result: jsonb('result').$type<Record<string, unknown>>(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_table_app_action_requests_request').on(table.app_id, table.user_id, table.request_id),
    index('idx_table_app_action_requests_app_created').on(table.app_id, table.created_at),
  ],
);

export type TableAppRow = typeof tableApps.$inferSelect;
export type TableAppVersionRow = typeof tableAppVersions.$inferSelect;
export type TableAppAudienceRow = typeof tableAppAudiences.$inferSelect;
export type TableAppPinRow = typeof tableAppPins.$inferSelect;
export type TableAppActionRequestRow = typeof tableAppActionRequests.$inferSelect;
