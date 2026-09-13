/**
 * Drizzle schema — internal multidimensional Tables application.
 *
 * Physical schema is fixed and migration-owned. User-created tables/fields are
 * metadata rows; only table_records.values needs JSONB path queries.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
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
import type {
  TableAutomationConfig,
  TableAutomationTrigger,
  TableBaseRole,
  TableBaseVisibility,
  TableDashboardWidgetType,
  TableFieldType,
  TableFormConfig,
  TableRecordValues,
  TableSchemaChangeType,
  TableSchemaSnapshot,
  TableViewScope,
} from '@greenhouse/types/tables';
import { driveFiles } from './drive.js';

export const tableBases = pgTable(
  'table_bases',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    visibility: text('visibility', { enum: ['private', 'team'] })
      .$type<TableBaseVisibility>()
      .notNull()
      .default('private'),
    owner_id: text('owner_id').notNull(),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('idx_table_bases_owner').on(table.owner_id),
    index('idx_table_bases_visibility').on(table.visibility),
    index('idx_table_bases_updated').on(table.updated_at),
  ],
);

export const tableBaseMembers = pgTable(
  'table_base_members',
  {
    id: serial('id').primaryKey(),
    base_id: integer('base_id')
      .notNull()
      .references(() => tableBases.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    role: text('role', { enum: ['owner', 'builder', 'editor', 'viewer'] })
      .$type<TableBaseRole>()
      .notNull()
      .default('viewer'),
    added_by: text('added_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_table_base_members_base_user').on(table.base_id, table.user_id),
    index('idx_table_base_members_user').on(table.user_id),
  ],
);

export const tableTables = pgTable(
  'table_tables',
  {
    id: serial('id').primaryKey(),
    base_id: integer('base_id')
      .notNull()
      .references(() => tableBases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    position: integer('position').notNull().default(0),
    schema_revision: integer('schema_revision').notNull().default(1),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('uq_table_tables_base_name').on(table.base_id, table.name),
    index('idx_table_tables_base_position').on(table.base_id, table.position),
  ],
);

export const tableSchemaVersions = pgTable(
  'table_schema_versions',
  {
    id: serial('id').primaryKey(),
    table_id: integer('table_id')
      .notNull()
      .references(() => tableTables.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    schema_snapshot: jsonb('schema_snapshot').$type<TableSchemaSnapshot>().notNull(),
    change_type: text('change_type', {
      enum: ['created', 'field_created', 'field_updated', 'field_archived'],
    })
      .$type<TableSchemaChangeType>()
      .notNull(),
    changed_by: text('changed_by').notNull(),
    request_id: text('request_id'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_table_schema_versions_table_version').on(table.table_id, table.version),
    index('idx_table_schema_versions_table_created').on(table.table_id, table.created_at),
  ],
);

export const tableFields = pgTable(
  'table_fields',
  {
    id: serial('id').primaryKey(),
    table_id: integer('table_id')
      .notNull()
      .references(() => tableTables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', {
      enum: [
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
      ],
    })
      .$type<TableFieldType>()
      .notNull(),
    required: boolean('required').notNull().default(false),
    is_primary: boolean('is_primary').notNull().default(false),
    config: text('config').notNull().default('{}'),
    position: integer('position').notNull().default(0),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('uq_table_fields_table_name').on(table.table_id, table.name),
    uniqueIndex('uq_table_fields_primary')
      .on(table.table_id)
      .where(sql`${table.is_primary} = true AND ${table.archived_at} IS NULL`),
    index('idx_table_fields_table_position').on(table.table_id, table.position),
  ],
);

export const tableFieldDependencies = pgTable(
  'table_field_dependencies',
  {
    field_id: integer('field_id')
      .notNull()
      .references(() => tableFields.id, { onDelete: 'cascade' }),
    depends_on_field_id: integer('depends_on_field_id')
      .notNull()
      .references(() => tableFields.id, { onDelete: 'cascade' }),
    dependency_type: text('dependency_type', { enum: ['formula', 'lookup', 'rollup'] }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.field_id, table.depends_on_field_id] }),
    index('idx_table_field_dependencies_source').on(table.depends_on_field_id),
  ],
);

export const tableViews = pgTable(
  'table_views',
  {
    id: serial('id').primaryKey(),
    table_id: integer('table_id')
      .notNull()
      .references(() => tableTables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: ['grid'] })
      .notNull()
      .default('grid'),
    scope: text('scope', { enum: ['shared', 'personal'] })
      .$type<TableViewScope>()
      .notNull()
      .default('shared'),
    owner_id: text('owner_id'),
    config: text('config').notNull().default('{}'),
    position: integer('position').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_table_views_table_position').on(table.table_id, table.position),
    index('idx_table_views_owner').on(table.owner_id),
  ],
);

export const tableForms = pgTable(
  'table_forms',
  {
    id: serial('id').primaryKey(),
    table_id: integer('table_id')
      .notNull()
      .references(() => tableTables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status', { enum: ['draft', 'published'] })
      .notNull()
      .default('draft'),
    config: jsonb('config').$type<TableFormConfig>().notNull(),
    revision: integer('revision').notNull().default(1),
    created_by: text('created_by').notNull(),
    updated_by: text('updated_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_table_forms_table_name').on(table.table_id, table.name),
    index('idx_table_forms_table_status').on(table.table_id, table.status),
  ],
);

export const tableRecords = pgTable(
  'table_records',
  {
    id: serial('id').primaryKey(),
    table_id: integer('table_id')
      .notNull()
      .references(() => tableTables.id, { onDelete: 'cascade' }),
    values: jsonb('values')
      .$type<TableRecordValues>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    computed_values: jsonb('computed_values')
      .$type<TableRecordValues>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    computed_revision: integer('computed_revision').notNull().default(1),
    computed_at: timestamp('computed_at', { withTimezone: true, mode: 'string' }),
    revision: integer('revision').notNull().default(1),
    created_by: text('created_by').notNull(),
    updated_by: text('updated_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    deleted_at: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('idx_table_records_table_id').on(table.table_id, table.id),
    index('idx_table_records_table_updated').on(table.table_id, table.updated_at),
    index('idx_table_records_deleted').on(table.table_id, table.deleted_at),
  ],
);

export const tableRecordLinks = pgTable(
  'table_record_links',
  {
    id: serial('id').primaryKey(),
    field_id: integer('field_id')
      .notNull()
      .references(() => tableFields.id, { onDelete: 'cascade' }),
    source_record_id: integer('source_record_id')
      .notNull()
      .references(() => tableRecords.id, { onDelete: 'cascade' }),
    target_record_id: integer('target_record_id')
      .notNull()
      .references(() => tableRecords.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
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

export const tableRecordAttachments = pgTable(
  'table_record_attachments',
  {
    id: serial('id').primaryKey(),
    record_id: integer('record_id')
      .notNull()
      .references(() => tableRecords.id, { onDelete: 'cascade' }),
    field_id: integer('field_id')
      .notNull()
      .references(() => tableFields.id, { onDelete: 'cascade' }),
    drive_file_id: integer('drive_file_id')
      .notNull()
      .references(() => driveFiles.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_table_record_attachments_record_field_file').on(
      table.record_id,
      table.field_id,
      table.drive_file_id,
    ),
    index('idx_table_record_attachments_record').on(table.record_id, table.field_id, table.position),
    index('idx_table_record_attachments_file').on(table.drive_file_id),
  ],
);

export const tableRecomputeJobs = pgTable(
  'table_recompute_jobs',
  {
    id: serial('id').primaryKey(),
    table_id: integer('table_id')
      .notNull()
      .references(() => tableTables.id, { onDelete: 'cascade' }),
    field_id: integer('field_id').references(() => tableFields.id, { onDelete: 'cascade' }),
    record_id: integer('record_id').references(() => tableRecords.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed'] })
      .notNull()
      .default('queued'),
    idempotency_key: text('idempotency_key').notNull(),
    attempt: integer('attempt').notNull().default(0),
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    started_at: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    finished_at: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('uq_table_recompute_jobs_idempotency').on(table.idempotency_key),
    index('idx_table_recompute_jobs_status').on(table.status, table.created_at),
  ],
);

export const tableAutomationRules = pgTable(
  'table_automation_rules',
  {
    id: serial('id').primaryKey(),
    base_id: integer('base_id')
      .notNull()
      .references(() => tableBases.id, { onDelete: 'cascade' }),
    table_id: integer('table_id')
      .notNull()
      .references(() => tableTables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status', { enum: ['disabled', 'enabled'] })
      .notNull()
      .default('disabled'),
    trigger: text('trigger', { enum: ['record_created', 'record_updated'] })
      .$type<TableAutomationTrigger>()
      .notNull(),
    config: jsonb('config').$type<TableAutomationConfig>().notNull(),
    execution_user_id: text('execution_user_id').notNull(),
    revision: integer('revision').notNull().default(1),
    created_by: text('created_by').notNull(),
    updated_by: text('updated_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_table_automation_rules_base_name').on(table.base_id, table.name),
    index('idx_table_automation_rules_trigger').on(table.table_id, table.status, table.trigger),
  ],
);

export const tableAutomationOutbox = pgTable(
  'table_automation_outbox',
  {
    id: serial('id').primaryKey(),
    rule_id: integer('rule_id')
      .notNull()
      .references(() => tableAutomationRules.id, { onDelete: 'cascade' }),
    record_id: integer('record_id')
      .notNull()
      .references(() => tableRecords.id, { onDelete: 'cascade' }),
    event_type: text('event_type', { enum: ['record_created', 'record_updated'] })
      .$type<TableAutomationTrigger>()
      .notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['pending', 'processing', 'succeeded', 'failed'] })
      .notNull()
      .default('pending'),
    idempotency_key: text('idempotency_key').notNull(),
    recursion_depth: integer('recursion_depth').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    processed_at: timestamp('processed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    uniqueIndex('uq_table_automation_outbox_idempotency').on(table.idempotency_key),
    index('idx_table_automation_outbox_status').on(table.status, table.created_at),
  ],
);

export const tableAutomationRuns = pgTable(
  'table_automation_runs',
  {
    id: serial('id').primaryKey(),
    rule_id: integer('rule_id')
      .notNull()
      .references(() => tableAutomationRules.id, { onDelete: 'cascade' }),
    outbox_id: integer('outbox_id').references(() => tableAutomationOutbox.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['running', 'succeeded', 'failed'] }).notNull(),
    actions_completed: integer('actions_completed').notNull().default(0),
    error: text('error'),
    started_at: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull(),
    finished_at: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('idx_table_automation_runs_rule').on(table.rule_id, table.started_at),
    index('idx_table_automation_runs_status').on(table.status, table.started_at),
  ],
);

export const tableNotifications = pgTable(
  'table_notifications',
  {
    id: serial('id').primaryKey(),
    base_id: integer('base_id')
      .notNull()
      .references(() => tableBases.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    rule_id: integer('rule_id').references(() => tableAutomationRules.id, { onDelete: 'set null' }),
    record_id: integer('record_id').references(() => tableRecords.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    message: text('message').notNull(),
    read_at: timestamp('read_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_table_notifications_user').on(table.user_id, table.read_at, table.created_at),
    index('idx_table_notifications_base').on(table.base_id, table.created_at),
  ],
);

export const tableDashboards = pgTable(
  'table_dashboards',
  {
    id: serial('id').primaryKey(),
    base_id: integer('base_id')
      .notNull()
      .references(() => tableBases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    revision: integer('revision').notNull().default(1),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_table_dashboards_base_name').on(table.base_id, table.name),
    index('idx_table_dashboards_base').on(table.base_id),
  ],
);

export const tableDashboardWidgets = pgTable(
  'table_dashboard_widgets',
  {
    id: serial('id').primaryKey(),
    dashboard_id: integer('dashboard_id')
      .notNull()
      .references(() => tableDashboards.id, { onDelete: 'cascade' }),
    table_id: integer('table_id').references(() => tableTables.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['kpi', 'bar', 'line', 'pie', 'records', 'text'] })
      .$type<TableDashboardWidgetType>()
      .notNull(),
    title: text('title').notNull(),
    config: text('config').notNull().default('{}'),
    layout: text('layout').$type<string>().notNull().default('{"x":0,"y":0,"w":6,"h":4}'),
    position: integer('position').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    created_by: text('created_by').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_table_dashboard_widgets_dashboard').on(table.dashboard_id, table.position),
    index('idx_table_dashboard_widgets_table').on(table.table_id),
  ],
);

export type TableBaseRow = typeof tableBases.$inferSelect;
export type TableBaseMemberRow = typeof tableBaseMembers.$inferSelect;
export type TableDefinitionRow = typeof tableTables.$inferSelect;
export type TableSchemaVersionRow = typeof tableSchemaVersions.$inferSelect;
export type TableFieldRow = typeof tableFields.$inferSelect;
export type TableFieldDependencyRow = typeof tableFieldDependencies.$inferSelect;
export type TableViewRow = typeof tableViews.$inferSelect;
export type TableFormRow = typeof tableForms.$inferSelect;
export type TableRecordRow = typeof tableRecords.$inferSelect;
export type TableRecordLinkRow = typeof tableRecordLinks.$inferSelect;
export type TableRecordAttachmentRow = typeof tableRecordAttachments.$inferSelect;
export type TableRecomputeJobRow = typeof tableRecomputeJobs.$inferSelect;
export type TableAutomationRuleRow = typeof tableAutomationRules.$inferSelect;
export type TableAutomationOutboxRow = typeof tableAutomationOutbox.$inferSelect;
export type TableAutomationRunRow = typeof tableAutomationRuns.$inferSelect;
export type TableNotificationRow = typeof tableNotifications.$inferSelect;
export type TableDashboardRow = typeof tableDashboards.$inferSelect;
export type TableDashboardWidgetRow = typeof tableDashboardWidgets.$inferSelect;
