import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, searchColumns, updatedAt } from './_columns.js';
import { files } from './files.js';
import { members } from './identity.js';

/**
 * 表格 (data-model.md §6): a base holds data tables, a table holds fields, views and records.
 * Computed fields (formula, lookup, rollup, AI) keep their values in `base_records.computed`
 * and their inputs in `base_field_deps`. Forms, imports and custom roles belong to a base;
 * automations join later. Who may do what is in `shares` (resource `base` or `form`), with a
 * custom role's row and column rules in `base_roles`.
 */

export const BASE_FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'checkbox',
  'date',
  'datetime',
  'single_select',
  'multi_select',
  'member',
  'url',
  'email',
  'phone',
  'attachment',
  'relation',
  'parent',
  'dependency',
  'formula',
  'lookup',
  'rollup',
  'ai',
] as const;
export type BaseFieldType = (typeof BASE_FIELD_TYPES)[number];
/** A dashboard belongs to the base, not to one table (`table_id` is null). */
export const BASE_VIEW_TYPES = ['grid', 'kanban', 'calendar', 'gallery', 'timeline', 'dashboard'] as const;
export type BaseViewType = (typeof BASE_VIEW_TYPES)[number];
export const RECORD_EVENT_TYPES = ['created', 'updated', 'deleted', 'restored'] as const;
export type RecordEventType = (typeof RECORD_EVENT_TYPES)[number];
export const RECORD_ACTOR_TYPES = ['member', 'agent', 'automation', 'form', 'import', 'app', 'system'] as const;
export type RecordActorType = (typeof RECORD_ACTOR_TYPES)[number];

/** A field's settings; which keys apply depends on its type (checked in @greenhouse/contract and the service). */
export type BaseFieldConfig = {
  /** Single and multi select: option ids are stored in records, labels are shown. */
  options?: Array<{ id: string; label: string; color: string }>;
  /** Number: decimal places shown. */
  precision?: number;
  /** Member and relation: more than one. */
  multiple?: boolean;
  /** Relation: the data table it links to, in the same base. */
  table_id?: string;
  /** Formula: the expression (FormulaExpression in @greenhouse/contract) and what it yields. */
  formula?: unknown;
  result?: string;
  /** Lookup and rollup: a link field of this table, and the field read in the records it links to. */
  link_field?: string;
  target_field?: string;
  /** Rollup: how the linked values are summed up. */
  aggregate?: string;
  /** AI: the instruction (fields as `{#id}`), the fields it reads, and whether edits regenerate it. */
  prompt?: string;
  inputs?: string[];
  auto_update?: boolean;
};
/** A view's filter, sorts, group, columns and type settings (viewConfigSchema in @greenhouse/contract). */
export type BaseViewConfig = Record<string, unknown>;
/** Values by field id. Link and attachment fields live in their own tables, not here. */
export type BaseRecordValues = Record<string, unknown>;
/** One field's change in a record event: values before and after (long text cut short). */
export type BaseRecordChange = { field: string; before?: unknown; after?: unknown };

export const bases = pgTable(
  'bases',
  {
    id: id(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    icon: text('icon').notNull().default(''),
    ownerId: text('owner_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    /** Set when made from a template (`project`). */
    templateKey: text('template_key'),
    templateVersion: text('template_version'),
    createdBy: text('created_by'),
    archivedAt: at('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('bases_owner_idx').on(t.ownerId)],
);

/** A data table. Names are unique among the live tables of a base. */
export const baseTables = pgTable(
  'base_tables',
  {
    id: id(),
    baseId: text('base_id')
      .notNull()
      .references(() => bases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    position: integer('position').notNull().default(0),
    /** Grows with every change to its fields. */
    schemaRevision: integer('schema_revision').notNull().default(1),
    createdBy: text('created_by'),
    archivedAt: at('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('base_tables_base_idx').on(t.baseId, t.position),
    uniqueIndex('base_tables_name_key')
      .on(t.baseId, t.name)
      .where(sql`${t.archivedAt} IS NULL`),
  ],
);

/**
 * A field. Each table has exactly one primary field (the record's title). An archived field
 * keeps its values in the records until it is deleted for good.
 */
export const baseFields = pgTable(
  'base_fields',
  {
    id: id(),
    tableId: text('table_id')
      .notNull()
      .references(() => baseTables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: BASE_FIELD_TYPES }).notNull(),
    required: boolean('required').notNull().default(false),
    isPrimary: boolean('is_primary').notNull().default(false),
    config: json<BaseFieldConfig>('config', {}),
    position: integer('position').notNull().default(0),
    createdBy: text('created_by'),
    archivedAt: at('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('base_fields_table_idx').on(t.tableId, t.position),
    uniqueIndex('base_fields_name_key')
      .on(t.tableId, t.name)
      .where(sql`${t.archivedAt} IS NULL`),
    uniqueIndex('base_fields_primary_key')
      .on(t.tableId)
      .where(sql`${t.isPrimary}`),
  ],
);

/**
 * What a computed field reads: `same` a field of its own record (formula, AI), `link` the link
 * field a lookup or rollup follows, `target` the field it reads in the linked records. A change
 * to `depends_on_field_id` recomputes `field_id`; the edges never form a cycle.
 */
export const baseFieldDeps = pgTable(
  'base_field_deps',
  {
    fieldId: text('field_id')
      .notNull()
      .references(() => baseFields.id, { onDelete: 'cascade' }),
    dependsOnFieldId: text('depends_on_field_id')
      .notNull()
      .references(() => baseFields.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['same', 'link', 'target'] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fieldId, t.dependsOnFieldId] }),
    index('base_field_deps_source_idx').on(t.dependsOnFieldId),
  ],
);

/**
 * A view of one table, or a dashboard of the base (no table). No owner: shared with everyone
 * who sees the base; an owner: theirs alone.
 */
export const baseViews = pgTable(
  'base_views',
  {
    id: id(),
    baseId: text('base_id')
      .notNull()
      .references(() => bases.id, { onDelete: 'cascade' }),
    tableId: text('table_id').references(() => baseTables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: BASE_VIEW_TYPES }).notNull(),
    ownerId: text('owner_id').references(() => members.id, { onDelete: 'cascade' }),
    config: json<BaseViewConfig>('config', {}),
    position: integer('position').notNull().default(0),
    /** Compare-and-set on every change. */
    revision: integer('revision').notNull().default(1),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('base_views_table_idx').on(t.tableId, t.position), index('base_views_base_idx').on(t.baseId)],
);

/**
 * A record. `values` holds scalar fields by field id; links and attachments are rows of their
 * own; `computed` holds what formula, lookup, rollup and AI fields work out (a failure as
 * `{ error }`). `revision` guards concurrent writes and moves only with `values`;
 * `computed_revision` moves with `computed`. `deleted_at` is the recycle bin (30 days).
 * `seq` is the creation order (a view without sorts lists records by it); ids stay random.
 */
export const baseRecords = pgTable(
  'base_records',
  {
    id: id(),
    seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    tableId: text('table_id')
      .notNull()
      .references(() => baseTables.id, { onDelete: 'cascade' }),
    values: json<BaseRecordValues>('values', {}),
    computed: json<BaseRecordValues>('computed', {}),
    revision: integer('revision').notNull().default(1),
    computedRevision: integer('computed_revision').notNull().default(0),
    /** A: the primary field; C: the other text, select labels and links' titles are not indexed. */
    ...searchColumns(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    deletedAt: at('deleted_at'),
    deletedBy: text('deleted_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('base_records_table_idx')
      .on(t.tableId, t.seq)
      .where(sql`${t.deletedAt} IS NULL`),
    index('base_records_trash_idx')
      .on(t.tableId, t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
    index('base_records_search_idx').using('gin', t.searchTsv),
  ],
);

/** The canonical edges of relation, parent and dependency fields, in order per source. */
export const baseRecordLinks = pgTable(
  'base_record_links',
  {
    fieldId: text('field_id')
      .notNull()
      .references(() => baseFields.id, { onDelete: 'cascade' }),
    sourceRecordId: text('source_record_id')
      .notNull()
      .references(() => baseRecords.id, { onDelete: 'cascade' }),
    targetRecordId: text('target_record_id')
      .notNull()
      .references(() => baseRecords.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.fieldId, t.sourceRecordId, t.targetRecordId] }),
    index('base_record_links_source_idx').on(t.sourceRecordId),
    index('base_record_links_target_idx').on(t.targetRecordId),
  ],
);

/** Files in a record's attachment field, in order. The bytes are in `files` (purpose `record`). */
export const baseRecordFiles = pgTable(
  'base_record_files',
  {
    recordId: text('record_id')
      .notNull()
      .references(() => baseRecords.id, { onDelete: 'cascade' }),
    fieldId: text('field_id')
      .notNull()
      .references(() => baseFields.id, { onDelete: 'cascade' }),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  // A file sits in one record's field at most.
  (t) => [
    primaryKey({ columns: [t.recordId, t.fieldId, t.fileId] }),
    uniqueIndex('base_record_files_file_key').on(t.fileId),
  ],
);

/** A record's history: who created, changed, deleted or restored it, and what changed. */
export const baseRecordEvents = pgTable(
  'base_record_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    recordId: text('record_id')
      .notNull()
      .references(() => baseRecords.id, { onDelete: 'cascade' }),
    tableId: text('table_id').notNull(),
    actorType: text('actor_type', { enum: RECORD_ACTOR_TYPES }).notNull(),
    actorId: text('actor_id'),
    type: text('type', { enum: RECORD_EVENT_TYPES }).notNull(),
    changes: json<BaseRecordChange[]>('changes', []),
    meta: json<Record<string, unknown>>('meta', {}),
    createdAt: createdAt(),
  },
  (t) => [index('base_record_events_record_idx').on(t.recordId, t.id)],
);

/**
 * A custom role of a base: per data table, whether it is seen and edited, which records
 * (a filter, `$me` allowed) and which fields are hidden. Members and groups get one through
 * `shares.custom_role_id`; owners, builders, editors and viewers see everything.
 */
export type BaseRoleRules = {
  tables?: Record<
    string,
    {
      access?: 'none' | 'read' | 'edit';
      rows?: Record<string, unknown> | null;
      hidden_fields?: string[];
    }
  >;
};

export const baseRoles = pgTable(
  'base_roles',
  {
    id: id(),
    baseId: text('base_id')
      .notNull()
      .references(() => bases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    rules: json<BaseRoleRules>('rules', {}),
    position: integer('position').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('base_roles_name_key').on(t.baseId, t.name)],
);

/** An internal form that adds records to one table. Who may submit is in `shares` (resource `form`). */
export type BaseFormConfig = Record<string, unknown>;

export const baseForms = pgTable(
  'base_forms',
  {
    id: id(),
    baseId: text('base_id')
      .notNull()
      .references(() => bases.id, { onDelete: 'cascade' }),
    tableId: text('table_id')
      .notNull()
      .references(() => baseTables.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: text('status', { enum: ['draft', 'published'] })
      .notNull()
      .default('draft'),
    config: json<BaseFormConfig>('config', {}),
    revision: integer('revision').notNull().default(1),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('base_forms_table_idx').on(t.tableId), index('base_forms_base_idx').on(t.baseId)],
);

/** One submission of a form; a form that takes one per member keeps it so by a partial unique index. */
export const baseFormSubmissions = pgTable(
  'base_form_submissions',
  {
    id: id(),
    formId: text('form_id')
      .notNull()
      .references(() => baseForms.id, { onDelete: 'cascade' }),
    memberId: text('member_id').notNull(),
    recordId: text('record_id').references(() => baseRecords.id, { onDelete: 'set null' }),
    singleSubmit: boolean('single_submit').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('base_form_submissions_form_idx').on(t.formId, t.createdAt),
    uniqueIndex('base_form_submissions_single_key')
      .on(t.formId, t.memberId)
      .where(sql`${t.singleSubmit}`),
  ],
);

/** A CSV import into one table: the file, how its columns map to fields, and how far it got. */
export type BaseImportMapping = Record<string, unknown>;
export type BaseImportResult = Record<string, unknown>;

export const baseImports = pgTable(
  'base_imports',
  {
    id: id(),
    baseId: text('base_id')
      .notNull()
      .references(() => bases.id, { onDelete: 'cascade' }),
    tableId: text('table_id')
      .notNull()
      .references(() => baseTables.id, { onDelete: 'cascade' }),
    memberId: text('member_id').notNull(),
    fileId: text('file_id').references(() => files.id, { onDelete: 'set null' }),
    mapping: json<BaseImportMapping>('mapping', {}),
    status: text('status', { enum: ['draft', 'queued', 'running', 'done', 'failed', 'cancelled'] })
      .notNull()
      .default('draft'),
    totalRows: integer('total_rows').notNull().default(0),
    /** Rows already written: a retry continues after them. */
    committedRows: integer('committed_rows').notNull().default(0),
    result: json<BaseImportResult>('result', {}),
    expiresAt: at('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('base_imports_table_idx').on(t.tableId, t.createdAt)],
);

export type BaseRow = typeof bases.$inferSelect;
export type BaseTableRow = typeof baseTables.$inferSelect;
export type BaseFieldRow = typeof baseFields.$inferSelect;
export type BaseViewRow = typeof baseViews.$inferSelect;
export type BaseRecordRow = typeof baseRecords.$inferSelect;
export type BaseRecordEventRow = typeof baseRecordEvents.$inferSelect;
export type BaseFieldDepRow = typeof baseFieldDeps.$inferSelect;
export type BaseRoleRow = typeof baseRoles.$inferSelect;
export type BaseFormRow = typeof baseForms.$inferSelect;
export type BaseFormSubmissionRow = typeof baseFormSubmissions.$inferSelect;
export type BaseImportRow = typeof baseImports.$inferSelect;
