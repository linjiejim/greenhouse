/**
 * Tables: bases → tables → fields / views / records, plus the formula / relation
 * infrastructure (record links, field dependencies, schema versions, recompute
 * jobs).
 *
 * Tables: table_bases, table_tables, table_fields, table_field_dependencies,
 * table_views, table_records, table_record_links, table_schema_versions,
 * table_recompute_jobs
 *
 * Members of a base are `shares` rows (resource_type = 'table_base'); record
 * attachments are `file_links` rows (target_type = 'table_record', slot = field
 * id). Three-level soft delete: `table_bases.archived_at`,
 * `table_tables.archived_at`, `table_records.deleted_at`.
 */

import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type {
  TableBaseVisibility,
  TableFieldConfig,
  TableFieldType,
  TableRecordValues,
  TableSchemaChangeType,
  TableSchemaSnapshot,
  TableViewConfig,
  TableViewScope,
} from '@greenhouse/types/tables';
import { at, createdAt, id, json, oneOf, updatedAt } from './_columns.js';

export const TABLE_BASE_VISIBILITIES = ['private', 'team'] as const;

export const tableBases = pgTable(
  'table_bases',
  {
    id: id(),
    name: text('name').notNull(),
    description: text('description'),
    visibility: text('visibility', { enum: TABLE_BASE_VISIBILITIES })
      .$type<TableBaseVisibility>()
      .notNull()
      .default('private'),
    owner_id: text('owner_id').notNull(),
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
    archived_at: at('archived_at'),
  },
  (table) => [
    index('idx_table_bases_owner').on(table.owner_id),
    index('idx_table_bases_visibility').on(table.visibility),
    index('idx_table_bases_updated').on(table.updated_at),
    oneOf('chk_table_bases_visibility', table.visibility, TABLE_BASE_VISIBILITIES),
  ],
);

export const tableTables = pgTable(
  'table_tables',
  {
    id: id(),
    base_id: text('base_id')
      .notNull()
      .references(() => tableBases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    position: integer('position').notNull().default(0),
    schema_revision: integer('schema_revision').notNull().default(1),
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
    archived_at: at('archived_at'),
  },
  (table) => [
    uniqueIndex('uq_table_tables_base_name').on(table.base_id, table.name),
    index('idx_table_tables_base_position').on(table.base_id, table.position),
  ],
);

export const TABLE_SCHEMA_CHANGE_TYPES = ['created', 'field_created', 'field_updated', 'field_archived'] as const;

export const tableSchemaVersions = pgTable(
  'table_schema_versions',
  {
    id: id(),
    table_id: text('table_id')
      .notNull()
      .references(() => tableTables.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    schema_snapshot: jsonb('schema_snapshot').$type<TableSchemaSnapshot>().notNull(),
    change_type: text('change_type', { enum: TABLE_SCHEMA_CHANGE_TYPES }).$type<TableSchemaChangeType>().notNull(),
    changed_by: text('changed_by').notNull(),
    request_id: text('request_id'),
    created_at: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_table_schema_versions_table_version').on(table.table_id, table.version),
    index('idx_table_schema_versions_table_created').on(table.table_id, table.created_at),
    oneOf('chk_table_schema_versions_change', table.change_type, TABLE_SCHEMA_CHANGE_TYPES),
  ],
);

export const TABLE_FIELD_TYPE_VALUES = [
  'text',
  'long_text',
  'number',
  'boolean',
  'date',
  'datetime',
  'single_select',
  'multi_select',
  'user',
  'multi_user',
  'url',
  'email',
  'phone',
  'attachment',
  'relation',
  'formula',
  'rollup',
] as const;

export const tableFields = pgTable(
  'table_fields',
  {
    id: id(),
    table_id: text('table_id')
      .notNull()
      .references(() => tableTables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: TABLE_FIELD_TYPE_VALUES }).$type<TableFieldType>().notNull(),
    required: boolean('required').notNull().default(false),
    is_primary: boolean('is_primary').notNull().default(false),
    config: json<TableFieldConfig>('config', {}),
    position: integer('position').notNull().default(0),
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
    archived_at: at('archived_at'),
  },
  (table) => [
    uniqueIndex('uq_table_fields_table_name').on(table.table_id, table.name),
    uniqueIndex('uq_table_fields_primary')
      .on(table.table_id)
      .where(sql`${table.is_primary} = true AND ${table.archived_at} IS NULL`),
    index('idx_table_fields_table_position').on(table.table_id, table.position),
    oneOf('chk_table_fields_type', table.type, TABLE_FIELD_TYPE_VALUES),
  ],
);

export const TABLE_DEPENDENCY_TYPES = ['formula', 'lookup', 'rollup'] as const;

export const tableFieldDependencies = pgTable(
  'table_field_dependencies',
  {
    field_id: text('field_id')
      .notNull()
      .references(() => tableFields.id, { onDelete: 'cascade' }),
    depends_on_field_id: text('depends_on_field_id')
      .notNull()
      .references(() => tableFields.id, { onDelete: 'cascade' }),
    dependency_type: text('dependency_type', { enum: TABLE_DEPENDENCY_TYPES }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.field_id, table.depends_on_field_id] }),
    index('idx_table_field_dependencies_source').on(table.depends_on_field_id),
    oneOf('chk_table_field_dependencies_type', table.dependency_type, TABLE_DEPENDENCY_TYPES),
  ],
);

export const TABLE_VIEW_SCOPES = ['shared', 'personal'] as const;

export const tableViews = pgTable(
  'table_views',
  {
    id: id(),
    table_id: text('table_id')
      .notNull()
      .references(() => tableTables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: ['grid'] })
      .notNull()
      .default('grid'),
    scope: text('scope', { enum: TABLE_VIEW_SCOPES }).$type<TableViewScope>().notNull().default('shared'),
    owner_id: text('owner_id'),
    config: json<TableViewConfig>('config', {}),
    position: integer('position').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    index('idx_table_views_table_position').on(table.table_id, table.position),
    index('idx_table_views_owner').on(table.owner_id),
    oneOf('chk_table_views_type', table.type, ['grid']),
    oneOf('chk_table_views_scope', table.scope, TABLE_VIEW_SCOPES),
  ],
);

export const tableRecords = pgTable(
  'table_records',
  {
    id: id(),
    table_id: text('table_id')
      .notNull()
      .references(() => tableTables.id, { onDelete: 'cascade' }),
    values: json<TableRecordValues>('values', {}),
    computed_values: json<TableRecordValues>('computed_values', {}),
    computed_revision: integer('computed_revision').notNull().default(1),
    computed_at: at('computed_at'),
    revision: integer('revision').notNull().default(1),
    created_by: text('created_by').notNull(),
    updated_by: text('updated_by').notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
    deleted_at: at('deleted_at'),
  },
  (table) => [
    index('idx_table_records_table_created').on(table.table_id, table.created_at, table.id),
    index('idx_table_records_table_updated').on(table.table_id, table.updated_at),
    index('idx_table_records_deleted').on(table.table_id, table.deleted_at),
  ],
);

export const tableRecordLinks = pgTable(
  'table_record_links',
  {
    id: id(),
    field_id: text('field_id')
      .notNull()
      .references(() => tableFields.id, { onDelete: 'cascade' }),
    source_record_id: text('source_record_id')
      .notNull()
      .references(() => tableRecords.id, { onDelete: 'cascade' }),
    target_record_id: text('target_record_id')
      .notNull()
      .references(() => tableRecords.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    created_by: text('created_by').notNull(),
    created_at: createdAt(),
  },
  (table) => [
    uniqueIndex('uq_table_record_links_field_source_target').on(
      table.field_id,
      table.source_record_id,
      table.target_record_id,
    ),
    index('idx_table_record_links_source').on(table.field_id, table.source_record_id, table.position),
    index('idx_table_record_links_target').on(table.field_id, table.target_record_id),
  ],
);

export const RECOMPUTE_JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;

export const tableRecomputeJobs = pgTable(
  'table_recompute_jobs',
  {
    id: id(),
    table_id: text('table_id')
      .notNull()
      .references(() => tableTables.id, { onDelete: 'cascade' }),
    field_id: text('field_id').references(() => tableFields.id, { onDelete: 'cascade' }),
    record_id: text('record_id').references(() => tableRecords.id, { onDelete: 'cascade' }),
    status: text('status', { enum: RECOMPUTE_JOB_STATUSES }).notNull().default('queued'),
    idempotency_key: text('idempotency_key').notNull(),
    attempt: integer('attempt').notNull().default(0),
    error: text('error'),
    created_at: createdAt(),
    started_at: at('started_at'),
    finished_at: at('finished_at'),
  },
  (table) => [
    uniqueIndex('uq_table_recompute_jobs_idempotency').on(table.idempotency_key),
    index('idx_table_recompute_jobs_status').on(table.status, table.created_at),
    oneOf('chk_table_recompute_jobs_status', table.status, RECOMPUTE_JOB_STATUSES),
  ],
);

export type TableBaseRow = typeof tableBases.$inferSelect;
export type TableDefinitionRow = typeof tableTables.$inferSelect;
export type TableSchemaVersionRow = typeof tableSchemaVersions.$inferSelect;
export type TableFieldRow = typeof tableFields.$inferSelect;
export type TableFieldDependencyRow = typeof tableFieldDependencies.$inferSelect;
export type TableViewRow = typeof tableViews.$inferSelect;
export type TableRecordRow = typeof tableRecords.$inferSelect;
export type TableRecordLinkRow = typeof tableRecordLinks.$inferSelect;
export type TableRecomputeJobRow = typeof tableRecomputeJobs.$inferSelect;
