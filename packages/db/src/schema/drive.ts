/**
 * Drizzle schema — Drive: a generic folder/file cabinet shared by committed scopes.
 *
 * Tables: drive_folders, drive_files
 *
 * One subsystem, two committed consumers:
 *   - scope='kb'  → knowledge-base folders that hold uploaded files alongside the
 *                   existing editable docs (knowledge_base.folder_id), keyed by the
 *                   KB access model (visibility + owner_user_id).
 *   - scope='tables' → Base-owned files keyed by base_id; authorization is the
 *                      intersection of Tables Base ACL and Drive access.
 *
 * An extension may own further scopes (`driveScopes` in the extension contract).
 * Those keep their owner in the generic `owner_key` column — one text key, whose
 * meaning only the owning extension knows — rather than adding a column here per
 * consumer, and authorize through the resolver the extension registers.
 *
 * Folders form a tree purely via parent_id (no materialized path): moving a folder
 * is a single parent_id change and the subtree follows; a breadcrumb is derived by
 * walking the parent chain. Files carry a server-generated, unique COS object key
 * (cos_key) and a pending→active→deleted lifecycle, so a presigned direct-upload
 * that never completes is never listed or served.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  pgTable,
  text,
  serial,
  timestamp,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// ─── drive_folders ────────────────────────────────────────

export const driveFolders = pgTable(
  'drive_folders',
  {
    id: serial('id').primaryKey(),
    // Open on purpose: 'kb' / 'tables' are core, extensions register their own.
    scope: text('scope').notNull(),
    // null = a root folder of its scope/owner. Self-referential tree.
    parent_id: integer('parent_id').references((): AnyPgColumn => driveFolders.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // ── scope='kb' access (mirrors knowledge_base): team = visibility='team',
    //    personal = visibility='private' + owner_user_id=<user>. ──
    visibility: text('visibility', { enum: ['team', 'private'] }),
    owner_user_id: text('owner_user_id'),
    // Logical reference to table_bases.id. Kept loose to avoid a schema-module cycle.
    base_id: integer('base_id'),
    // Owner of an extension scope — opaque to core (e.g. a CRM company id).
    owner_key: text('owner_key'),
    // Manual order among siblings, ascending. 0 = never ordered by hand, which is
    // every row until someone drags one — readers sort by (sort_order, name), so an
    // untouched tree stays alphabetical.
    sort_order: integer('sort_order').notNull().default(0),
    created_by: text('created_by'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_drive_folders_parent').on(table.parent_id),
    index('idx_drive_folders_kb').on(table.scope, table.visibility, table.owner_user_id),
    index('idx_drive_folders_tables').on(table.scope, table.base_id),
    index('idx_drive_folders_ext').on(table.scope, table.owner_key),
    check(
      'chk_drive_folders_scope_owner',
      sql`(
        (${table.scope} = 'kb' AND ${table.base_id} IS NULL AND ${table.owner_key} IS NULL AND ${table.visibility} IS NOT NULL AND (${table.visibility} = 'team' OR ${table.owner_user_id} IS NOT NULL))
        OR (${table.scope} = 'tables' AND ${table.base_id} IS NOT NULL AND ${table.owner_key} IS NULL AND ${table.visibility} IS NULL AND ${table.owner_user_id} IS NULL)
        OR (${table.scope} NOT IN ('kb', 'tables') AND ${table.owner_key} IS NOT NULL AND ${table.base_id} IS NULL AND ${table.visibility} IS NULL AND ${table.owner_user_id} IS NULL)
      )`,
    ),
  ],
);

// ─── drive_files ──────────────────────────────────────────

export const driveFiles = pgTable(
  'drive_files',
  {
    id: serial('id').primaryKey(),
    scope: text('scope').notNull(),
    // null = a file at the scope/owner root (no folder).
    folder_id: integer('folder_id').references(() => driveFolders.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // original display filename
    cos_key: text('cos_key').notNull(), // server-generated object key (storage location, never user-derived)
    content_type: text('content_type'),
    size: integer('size').notNull().default(0), // bytes; verified via HeadObject on complete
    status: text('status', { enum: ['pending', 'active', 'deleted'] })
      .notNull()
      .default('pending'),
    // ── scope='kb' access mirror ──
    visibility: text('visibility', { enum: ['team', 'private'] }),
    owner_user_id: text('owner_user_id'),
    base_id: integer('base_id'),
    owner_key: text('owner_key'),
    uploaded_by: text('uploaded_by'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_drive_files_cos_key').on(table.cos_key),
    index('idx_drive_files_folder').on(table.folder_id),
    index('idx_drive_files_kb').on(table.scope, table.visibility, table.owner_user_id),
    index('idx_drive_files_tables').on(table.scope, table.base_id),
    index('idx_drive_files_ext').on(table.scope, table.owner_key),
    index('idx_drive_files_status').on(table.status),
    check(
      'chk_drive_files_scope_owner',
      sql`(
        (${table.scope} = 'kb' AND ${table.base_id} IS NULL AND ${table.owner_key} IS NULL AND ${table.visibility} IS NOT NULL AND (${table.visibility} = 'team' OR ${table.owner_user_id} IS NOT NULL))
        OR (${table.scope} = 'tables' AND ${table.base_id} IS NOT NULL AND ${table.owner_key} IS NULL AND ${table.visibility} IS NULL AND ${table.owner_user_id} IS NULL)
        OR (${table.scope} NOT IN ('kb', 'tables') AND ${table.owner_key} IS NOT NULL AND ${table.base_id} IS NULL AND ${table.visibility} IS NULL AND ${table.owner_user_id} IS NULL)
      )`,
    ),
  ],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type DriveFolderRow = typeof driveFolders.$inferSelect;
export type DriveFileRow = typeof driveFiles.$inferSelect;
/** `'kb' | 'tables' | <extension scope>` — a plain string, validated at the edges. */
export type DriveScope = DriveFolderRow['scope'];
/** The two scopes core owns. */
export const CORE_DRIVE_SCOPES = ['kb', 'tables'] as const;
export type CoreDriveScope = (typeof CORE_DRIVE_SCOPES)[number];
export type DriveFileStatus = DriveFileRow['status'];
