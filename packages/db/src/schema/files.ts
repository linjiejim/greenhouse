/**
 * Folders, files, attachments and per-person sharing.
 *
 * Tables: folders, files, file_links, shares
 *
 * - `folders` is one tree per scope: `kb` (knowledge base, owner model mirrors
 *   documents: team / private + owner), `tables` (keyed by a table base) or an
 *   extension scope (opaque `owner_key`, authorized by the extension).
 * - `files` is the only place a stored object is registered, whatever put it
 *   there: the drive (`source='drive'`), a chat upload or tool output
 *   (`chat_upload` / `chat_output`, owned by the conversation) or a run
 *   (`run`). Object keys are server-generated and unique.
 * - `file_links` attaches a file to something else (a table record field, …).
 * - `shares` grants one member (or everyone) access to one resource beyond its
 *   owner: a document, a folder, a file or a table base.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, id, json, oneOf, updatedAt } from './_columns.js';
import { conversations } from './conversations.js';

export const FOLDER_VISIBILITIES = ['team', 'private'] as const;

export const folders = pgTable(
  'folders',
  {
    id: id(),
    /** `kb` / `tables` are core; extensions register their own. */
    scope: text('scope').notNull(),
    parent_id: text('parent_id').references((): AnyPgColumn => folders.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    visibility: text('visibility', { enum: FOLDER_VISIBILITIES }),
    owner_user_id: text('owner_user_id'),
    /** Logical reference to table_bases.id (scope `tables`). */
    base_id: text('base_id'),
    /** Owner of an extension scope — opaque to core (e.g. a CRM company id). */
    owner_key: text('owner_key'),
    /** Manual order among siblings; 0 = never ordered by hand (sorted last, then by name). */
    sort_order: integer('sort_order').notNull().default(0),
    created_by: text('created_by'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    index('idx_folders_parent').on(table.parent_id),
    index('idx_folders_kb').on(table.scope, table.visibility, table.owner_user_id),
    index('idx_folders_tables').on(table.scope, table.base_id),
    index('idx_folders_ext').on(table.scope, table.owner_key),
    oneOf('chk_folders_visibility', table.visibility, FOLDER_VISIBILITIES),
    check(
      'chk_folders_scope_owner',
      sql`(
        (${table.scope} = 'kb' AND ${table.base_id} IS NULL AND ${table.owner_key} IS NULL AND ${table.visibility} IS NOT NULL AND (${table.visibility} = 'team' OR ${table.owner_user_id} IS NOT NULL))
        OR (${table.scope} = 'tables' AND ${table.base_id} IS NOT NULL AND ${table.owner_key} IS NULL AND ${table.visibility} IS NULL AND ${table.owner_user_id} IS NULL)
        OR (${table.scope} NOT IN ('kb', 'tables') AND ${table.owner_key} IS NOT NULL AND ${table.base_id} IS NULL AND ${table.visibility} IS NULL AND ${table.owner_user_id} IS NULL)
      )`,
    ),
  ],
);

export const FILE_SOURCES = ['drive', 'chat_upload', 'chat_output', 'run'] as const;
export const FILE_STATUSES = ['pending', 'active', 'failed', 'skipped', 'deleted'] as const;

export const files = pgTable(
  'files',
  {
    id: id(),
    source: text('source', { enum: FILE_SOURCES }).notNull(),
    name: text('name').notNull(),
    content_type: text('content_type'),
    size: bigint('size', { mode: 'number' }).notNull().default(0),
    sha256: text('sha256'),
    /** Server-generated object key; null only for a run artifact that never stored bytes. */
    storage_key: text('storage_key'),
    /** pending → active → deleted for uploads; a run artifact may end failed / skipped. */
    status: text('status', { enum: FILE_STATUSES }).notNull().default('pending'),
    // ── drive placement (source = 'drive') ──
    scope: text('scope'),
    folder_id: text('folder_id').references(() => folders.id, { onDelete: 'cascade' }),
    visibility: text('visibility', { enum: FOLDER_VISIBILITIES }),
    owner_user_id: text('owner_user_id'),
    base_id: text('base_id'),
    owner_key: text('owner_key'),
    // ── conversation ownership (source = chat_*) ──
    session_id: text('session_id').references(() => conversations.id, { onDelete: 'cascade' }),
    // ── run provenance (source = 'run'; logical) ──
    run_id: text('run_id'),
    /** Source-specific details (a run artifact's direction / kind / path / step). */
    meta: json<Record<string, unknown>>('meta', {}),
    created_by: text('created_by'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_files_storage_key')
      .on(table.storage_key)
      .where(sql`${table.storage_key} IS NOT NULL`),
    index('idx_files_folder').on(table.folder_id),
    index('idx_files_drive_kb').on(table.scope, table.visibility, table.owner_user_id),
    index('idx_files_drive_tables').on(table.scope, table.base_id),
    index('idx_files_drive_ext').on(table.scope, table.owner_key),
    index('idx_files_session').on(table.session_id),
    index('idx_files_run').on(table.run_id),
    index('idx_files_created_by').on(table.created_by),
    index('idx_files_status').on(table.status),
    oneOf('chk_files_source', table.source, FILE_SOURCES),
    oneOf('chk_files_status', table.status, FILE_STATUSES),
    oneOf('chk_files_visibility', table.visibility, FOLDER_VISIBILITIES),
    check('chk_files_size', sql`${table.size} >= 0`),
    check(
      'chk_files_source_owner',
      sql`(
        (${table.source} = 'drive' AND ${table.scope} IS NOT NULL AND ${table.storage_key} IS NOT NULL AND ${table.session_id} IS NULL AND ${table.run_id} IS NULL AND (
          (${table.scope} = 'kb' AND ${table.base_id} IS NULL AND ${table.owner_key} IS NULL AND ${table.visibility} IS NOT NULL AND (${table.visibility} = 'team' OR ${table.owner_user_id} IS NOT NULL))
          OR (${table.scope} = 'tables' AND ${table.base_id} IS NOT NULL AND ${table.owner_key} IS NULL AND ${table.visibility} IS NULL AND ${table.owner_user_id} IS NULL)
          OR (${table.scope} NOT IN ('kb', 'tables') AND ${table.owner_key} IS NOT NULL AND ${table.base_id} IS NULL AND ${table.visibility} IS NULL AND ${table.owner_user_id} IS NULL)
        ))
        OR (${table.source} IN ('chat_upload', 'chat_output') AND ${table.session_id} IS NOT NULL AND ${table.storage_key} IS NOT NULL AND ${table.scope} IS NULL AND ${table.folder_id} IS NULL)
        OR (${table.source} = 'run' AND ${table.run_id} IS NOT NULL AND ${table.scope} IS NULL AND ${table.folder_id} IS NULL AND ${table.session_id} IS NULL)
      )`,
    ),
  ],
);

export const FILE_LINK_TARGETS = ['table_record', 'message', 'task', 'kb_document'] as const;

/**
 * A file attached to something. `slot` narrows the place on the target (the
 * table field id for a record attachment; '' when the target has one place).
 * Targets are logical references; the owning service deletes links when it
 * hard-deletes a target.
 */
export const fileLinks = pgTable(
  'file_links',
  {
    file_id: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    target_type: text('target_type', { enum: FILE_LINK_TARGETS }).notNull(),
    target_id: text('target_id').notNull(),
    slot: text('slot').notNull().default(''),
    position: integer('position').notNull().default(0),
    created_by: text('created_by'),
    created_at: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.file_id, table.target_type, table.target_id, table.slot] }),
    index('idx_file_links_target').on(table.target_type, table.target_id, table.slot, table.position),
    oneOf('chk_file_links_target', table.target_type, FILE_LINK_TARGETS),
  ],
);

export const SHARE_RESOURCES = ['kb_document', 'folder', 'file', 'table_base'] as const;
export const SHARE_PRINCIPALS = ['user', 'team'] as const;
/** kb: reader / editor; table bases: owner / builder / editor / viewer. */
export const SHARE_ROLES = ['reader', 'editor', 'viewer', 'builder', 'owner'] as const;

export const shares = pgTable(
  'shares',
  {
    id: id(),
    resource_type: text('resource_type', { enum: SHARE_RESOURCES }).notNull(),
    resource_id: text('resource_id').notNull(),
    principal_type: text('principal_type', { enum: SHARE_PRINCIPALS }).notNull().default('user'),
    /** Member id; null when principal_type = 'team'. */
    principal_id: text('principal_id'),
    role: text('role', { enum: SHARE_ROLES }).notNull(),
    message: text('message'),
    created_by: text('created_by'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    unique('uq_shares_grant')
      .on(table.resource_type, table.resource_id, table.principal_type, table.principal_id)
      .nullsNotDistinct(),
    index('idx_shares_principal').on(table.principal_type, table.principal_id, table.resource_type),
    oneOf('chk_shares_resource', table.resource_type, SHARE_RESOURCES),
    oneOf('chk_shares_principal', table.principal_type, SHARE_PRINCIPALS),
    oneOf('chk_shares_role', table.role, SHARE_ROLES),
    check('chk_shares_principal_id', sql`(${table.principal_type} = 'team') = (${table.principal_id} IS NULL)`),
  ],
);

export type DriveFolderRow = typeof folders.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type FileSource = FileRow['source'];
export type FileStatus = FileRow['status'];
export type FileLinkRow = typeof fileLinks.$inferSelect;
export type ShareRow = typeof shares.$inferSelect;
export type ShareResourceType = ShareRow['resource_type'];
export type ShareRole = ShareRow['role'];
/** `'kb' | 'tables' | <extension scope>` — a plain string, validated at the edges. */
export type DriveScope = DriveFolderRow['scope'];
/** The two scopes core owns. */
export const CORE_DRIVE_SCOPES = ['kb', 'tables'] as const;
export type CoreDriveScope = (typeof CORE_DRIVE_SCOPES)[number];
