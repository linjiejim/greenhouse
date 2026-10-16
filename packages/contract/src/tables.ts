import { z } from 'zod';
import { AUDIENCE_TYPES } from './agents.js';
import { isoTime } from './common.js';
import { commentSchema, memberRefSchema } from './knowledge.js';

/**
 * 表格 (TBL-01 to TBL-18): a base holds data tables; a table holds fields, views and records.
 * Values are keyed by field id. Scalar fields hold a string, number or boolean; member, multi
 * select, link (relation, parent, dependency) and attachment fields hold a list of ids. A write
 * names the revision it is based on and a newer one refuses it (409 `stale_revision`).
 * Computed fields (formula, lookup, rollup, AI) are worked out by the server and never written:
 * their values come in `values` like the others, a failure as `{ error }` (COMPUTED_ERRORS).
 */

export const FIELD_TYPES = [
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
export type FieldType = (typeof FIELD_TYPES)[number];
/** Fields the server works out; writes to them are refused. */
export const COMPUTED_FIELD_TYPES = ['formula', 'lookup', 'rollup', 'ai'] as const satisfies readonly FieldType[];
export type ComputedFieldType = (typeof COMPUTED_FIELD_TYPES)[number];
export const isComputedType = (type: FieldType): type is ComputedFieldType =>
  (COMPUTED_FIELD_TYPES as readonly FieldType[]).includes(type);
/** What a formula yields, named like the stored type it behaves as. */
export const FORMULA_RESULTS = [
  'text',
  'number',
  'checkbox',
  'date',
  'datetime',
] as const satisfies readonly FieldType[];
export type FormulaResult = (typeof FORMULA_RESULTS)[number];
/** How a rollup sums up the values it reads in the linked records. */
export const ROLLUP_AGGREGATES = ['count', 'count_values', 'count_unique', 'sum', 'avg', 'min', 'max', 'join'] as const;
export type RollupAggregate = (typeof ROLLUP_AGGREGATES)[number];
/**
 * Why a computed value could not be worked out, shown in its cell: a division by zero, text
 * where a number belongs, a field it reads is gone, a loop, too much work; for AI fields the
 * model failed, the budget is used up or no model is set up. `pending` is an AI value on its way.
 */
export const COMPUTED_ERRORS = [
  'div_zero',
  'not_number',
  'missing_field',
  'cycle',
  'too_large',
  'ai_failed',
  'budget_exceeded',
  'no_model',
] as const;
export type ComputedError = (typeof COMPUTED_ERRORS)[number];
/** A computed cell that failed: `{ error: 'div_zero' }`; an AI cell still being written: `{ pending: true }`. */
export const isComputedError = (value: unknown): value is { error: ComputedError } =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof (value as { error?: unknown }).error === 'string';
export const isComputedPending = (value: unknown): value is { pending: true } =>
  !!value && typeof value === 'object' && !Array.isArray(value) && (value as { pending?: unknown }).pending === true;
/** Fields whose value is a list of record ids, kept as links: to another table, or within the table. */
export const LINK_FIELD_TYPES = ['relation', 'parent', 'dependency'] as const satisfies readonly FieldType[];
/** Fields whose value is a list. */
export const LIST_FIELD_TYPES = [
  'multi_select',
  'member',
  'attachment',
  'relation',
  'parent',
  'dependency',
] as const satisfies readonly FieldType[];
/** Text-like fields the toolbar search looks in. */
export const TEXT_FIELD_TYPES = ['text', 'long_text', 'url', 'email', 'phone'] as const satisfies readonly FieldType[];
/** The types a table's primary field (the record's title) can have. */
export const PRIMARY_FIELD_TYPES = ['text'] as const satisfies readonly FieldType[];

export const isLinkType = (type: FieldType): type is (typeof LINK_FIELD_TYPES)[number] =>
  (LINK_FIELD_TYPES as readonly FieldType[]).includes(type);
export const isListType = (type: FieldType) => (LIST_FIELD_TYPES as readonly FieldType[]).includes(type);

/** Columns every record has, usable in filters, sorts and groups next to the fields. */
export const SYSTEM_FIELDS = ['created_by', 'created_at', 'updated_by', 'updated_at'] as const;
export type SystemField = (typeof SYSTEM_FIELDS)[number];
export const isSystemField = (value: string): value is SystemField =>
  (SYSTEM_FIELDS as readonly string[]).includes(value);

export const VIEW_TYPES = ['grid', 'kanban', 'calendar', 'gallery', 'timeline', 'dashboard'] as const;
export type ViewType = (typeof VIEW_TYPES)[number];
/** Views of one data table; a dashboard belongs to the base (its `table_id` is null). */
export const TABLE_VIEW_TYPES = [
  'grid',
  'kanban',
  'calendar',
  'gallery',
  'timeline',
] as const satisfies readonly ViewType[];
/** What the reader may do in a base: owner (sharing, deleting), builder (structure), editor (records), viewer. */
export const BASE_ROLES = ['owner', 'builder', 'editor', 'viewer'] as const;
export type BaseRole = (typeof BASE_ROLES)[number];
const ROLE_RANK: Record<BaseRole, number> = { viewer: 1, editor: 2, builder: 3, owner: 4 };
export const roleAtLeast = (role: BaseRole | null | undefined, needed: BaseRole): boolean =>
  !!role && ROLE_RANK[role] >= ROLE_RANK[needed];
/** Groups and the whole workspace can read or edit records, never build or own. */
export const GROUP_SHARE_ROLES = ['editor', 'viewer'] as const;
/**
 * A custom role (base_roles) says per data table whether it is seen and edited, which records
 * (a filter, `$me` is the reader) and which fields stay hidden. Tables it does not name are not
 * seen. Several custom roles add up; any of the four roles above sees everything.
 */
export const ROLE_TABLE_ACCESS = ['none', 'read', 'edit'] as const;
export type RoleTableAccess = (typeof ROLE_TABLE_ACCESS)[number];
export const MAX_ROLES = 20;
/** Bases the server can make for you; 项目 is projects, tasks, milestones, owners, dates and dependencies. */
export const BASE_TEMPLATES = ['project'] as const;
export type BaseTemplate = (typeof BASE_TEMPLATES)[number];

export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_empty',
  'is_not_empty',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];
/** Filter values that stand for something at query time: the reader, and days around today. */
export const FILTER_TOKENS = ['$me', '$today', '$yesterday', '$tomorrow', '$week_start', '$month_start'] as const;
export const OPTION_COLORS = ['gray', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'purple'] as const;
export type OptionColor = (typeof OPTION_COLORS)[number];
export const ROW_HEIGHTS = ['short', 'medium', 'tall'] as const;
export const TIMELINE_SCALES = ['day', 'week', 'month'] as const;
export type TimelineScale = (typeof TIMELINE_SCALES)[number];

export const BASE_NAME_MAX = 100;
export const TABLE_NAME_MAX = 100;
export const FIELD_NAME_MAX = 100;
export const VIEW_NAME_MAX = 60;
export const OPTION_LABEL_MAX = 100;
export const TEXT_MAX = 10_000;
export const LONG_TEXT_MAX = 100_000;
export const MAX_FIELDS = 200;
export const MAX_OPTIONS = 200;
export const MAX_TABLES = 50;
/** Views of one data table one member sees: the shared ones and their own. */
export const MAX_VIEWS = 100;
export const MAX_FILTER_CLAUSES = 20;
export const MAX_SORTS = 3;
/** Records one query page returns at most; the web loads a view page by page up to MAX_VIEW_RECORDS. */
export const MAX_QUERY_LIMIT = 500;
export const MAX_VIEW_RECORDS = 5000;
/** Records one bulk write (a paste) or bulk delete may touch. */
export const MAX_BULK = 500;
/** Ids one list value may hold (members, options, links, files). */
export const MAX_LIST_VALUES = 500;
/** Deleted records stay in the recycle bin this long. */
export const TRASH_DAYS = 30;

/** A record's address: `#/tables/<base>/<table>?record=<id>`. */
export const recordHref = (baseId: string, tableId: string, recordId: string) =>
  `#/tables/${baseId}/${tableId}?record=${recordId}`;

/**
 * The stored type a field's value behaves as, for filters, sorts, groups and cells: a formula as
 * its result, a rollup as a number (or the date or text it picks), an AI field as text. A lookup
 * stays a lookup: a list of the values it reads.
 */
export function valueTypeOf(field: { type: FieldType; config: { result?: string | undefined } }): FieldType {
  switch (field.type) {
    case 'formula':
    case 'rollup':
      return (FORMULA_RESULTS as readonly string[]).includes(field.config.result ?? '')
        ? (field.config.result as FieldType)
        : field.type === 'formula'
          ? 'text'
          : 'number';
    case 'ai':
      return 'text';
    default:
      return field.type;
  }
}

/** Which filter operators make sense for a type (the web offers these; the server refuses others). */
export function operatorsFor(type: FieldType | SystemField): readonly FilterOperator[] {
  switch (type) {
    case 'number':
    case 'date':
    case 'datetime':
    case 'created_at':
    case 'updated_at':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'];
    case 'text':
    case 'long_text':
    case 'url':
    case 'email':
    case 'phone':
      return ['contains', 'not_contains', 'eq', 'neq', 'is_empty', 'is_not_empty'];
    case 'checkbox':
      return ['eq'];
    case 'single_select':
    case 'created_by':
    case 'updated_by':
      return ['eq', 'neq', 'is_empty', 'is_not_empty'];
    case 'multi_select':
    case 'member':
    case 'relation':
    case 'parent':
    case 'dependency':
      return ['contains', 'not_contains', 'is_empty', 'is_not_empty'];
    case 'attachment':
      return ['is_empty', 'is_not_empty'];
    case 'lookup':
      return ['contains', 'not_contains', 'is_empty', 'is_not_empty'];
    case 'formula':
    case 'rollup':
    case 'ai':
      return operatorsFor(type === 'rollup' ? 'number' : 'text');
  }
}

/** Fields a view can sort by: lists cannot (a member field sorts by the first member's name). */
export const canSortBy = (type: FieldType | SystemField) =>
  !['attachment', 'relation', 'parent', 'dependency', 'multi_select', 'lookup'].includes(type);
/** Fields a view can group by: one value per record (a member field groups by its first member). */
export const canGroupBy = (type: FieldType | SystemField) =>
  ['text', 'number', 'checkbox', 'date', 'single_select', 'member', 'url', 'email', 'phone', 'created_by'].includes(
    type,
  );

const idField = z.string().min(1).max(64);
/** A field id, or one of the system fields. */
const fieldRef = z.string().min(1).max(64);

export const selectOptionSchema = z.object({
  /** Stored in records; stays when the label changes. */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  label: z.string().trim().min(1).max(OPTION_LABEL_MAX),
  color: z.enum(OPTION_COLORS),
});
export type SelectOption = z.infer<typeof selectOptionSchema>;

export const FORMULA_TEXT_MAX = 4000;
export const AI_PROMPT_MAX = 4000;
export const MAX_AI_INPUTS = 20;

/** Which keys apply depends on the type; the others are dropped when saved. */
export const fieldConfigSchema = z.object({
  /** Single and multi select. */
  options: z.array(selectOptionSchema).max(MAX_OPTIONS).optional(),
  /** Number, and numeric formulas and rollups: decimal places shown, 0–6. */
  precision: z.number().int().min(0).max(6).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  /** Member and relation: more than one. */
  multiple: z.boolean().optional(),
  /** Relation: the data table it links to, in the same base. */
  table_id: idField.optional(),
  /**
   * Formula: the text as typed, fields as `{Name}` (sent when saving; the server keeps the
   * parsed expression in `formula` and answers with the text written with today's names).
   */
  formula_text: z.string().max(FORMULA_TEXT_MAX).optional(),
  /** Formula: the parsed expression (FormulaExpression in tables-formula.ts), kept by the server. */
  formula: z.unknown().optional(),
  /** Formula and rollup: what the value is (the server works it out; a formula may choose). */
  result: z.enum(FORMULA_RESULTS).optional(),
  /** Lookup and rollup: a relation, parent or dependency field of this table... */
  link_field: idField.optional(),
  /** ...and the field read in the records it links to. */
  target_field: idField.optional(),
  /** Rollup: how those values are summed up. */
  aggregate: z.enum(ROLLUP_AGGREGATES).optional(),
  /** AI: the instruction, fields as `{Name}` like a formula (kept with `{#id}`; answered with names). */
  prompt: z.string().max(AI_PROMPT_MAX).optional(),
  /** AI: the fields the prompt reads (worked out by the server). */
  inputs: z.array(idField).max(MAX_AI_INPUTS).optional(),
  /** AI: write it again when a field it reads changes (default on). */
  auto_update: z.boolean().optional(),
});
export type FieldConfig = z.infer<typeof fieldConfigSchema>;

export const fieldSchema = z.object({
  id: z.string(),
  table_id: z.string(),
  name: z.string(),
  type: z.enum(FIELD_TYPES),
  config: fieldConfigSchema,
  required: z.boolean(),
  /** The record's title; every table has one, and it cannot be deleted. */
  is_primary: z.boolean(),
  position: z.number().int(),
});
export type Field = z.infer<typeof fieldSchema>;

export const createFieldInputSchema = z.object({
  name: z.string().trim().min(1).max(FIELD_NAME_MAX),
  type: z.enum(FIELD_TYPES),
  config: fieldConfigSchema.optional(),
  required: z.boolean().optional(),
});
export type CreateFieldInput = z.infer<typeof createFieldInputSchema>;

/**
 * Rename, change settings or the place among the table's fields; the type changes only between
 * text kinds. `schema_revision` is the table's as last read: a newer one answers 409 `stale_schema`.
 */
export const updateFieldInputSchema = z.object({
  schema_revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(FIELD_NAME_MAX).optional(),
  type: z.enum(FIELD_TYPES).optional(),
  config: fieldConfigSchema.optional(),
  required: z.boolean().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});
export type UpdateFieldInput = z.infer<typeof updateFieldInputSchema>;

/** A filter value: a short text, a number, a boolean, or a few of them (ids). */
const filterValueSchema = z.union([
  z.string().max(1000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(200), z.number()])).max(100),
]);

export const filterClauseSchema = z.object({
  field: fieldRef,
  op: z.enum(FILTER_OPERATORS),
  /** A value of the field's kind, an option or member id, or a token (`$me`, `$today`…). */
  value: filterValueSchema.optional(),
});
export type FilterClause = z.infer<typeof filterClauseSchema>;
export const filterSchema = z.object({
  mode: z.enum(['and', 'or']),
  clauses: z.array(filterClauseSchema).max(MAX_FILTER_CLAUSES),
});
export type Filter = z.infer<typeof filterSchema>;
export const sortSchema = z.object({ field: fieldRef, desc: z.boolean().optional() });
export type Sort = z.infer<typeof sortSchema>;
export const viewGroupSchema = z.object({ field: fieldRef, desc: z.boolean().optional() });
export type ViewGroup = z.infer<typeof viewGroupSchema>;

// ── Dashboard cards (one schema for dashboards and, later, apps) ──

export const CARD_KINDS = ['number', 'bar', 'line', 'pie', 'list'] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const CARD_AGGREGATES = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type CardAggregate = (typeof CARD_AGGREGATES)[number];
/** Dates group into these. */
export const DATE_BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type DateBucket = (typeof DATE_BUCKETS)[number];
export const CARD_SIZES = ['small', 'medium', 'large'] as const;
export const MAX_CARDS = 30;
/** Bars, points or slices one card shows at most (the rest add up as 「其他」). */
export const MAX_CARD_GROUPS = 50;
export const MAX_CARD_LIST = 50;

/**
 * One card of a dashboard: what it counts in which data table, read with the reader's own
 * access (a custom role's rows and fields apply). `number` is one figure; `bar`, `line` and
 * `pie` one figure per value of `group`; `list` the first records with a few fields.
 */
export const cardSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  kind: z.enum(CARD_KINDS),
  title: z.string().trim().max(100),
  table_id: idField,
  filter: filterSchema.optional(),
  /** What each figure is: a count of records, or a sum, average, least or most of a field. */
  measure: z.object({ aggregate: z.enum(CARD_AGGREGATES), field: fieldRef.optional() }).optional(),
  /** Bar, line, pie: one figure per value of this field; dates in buckets. */
  group: z
    .object({
      field: fieldRef,
      bucket: z.enum(DATE_BUCKETS).optional(),
      limit: z.number().int().min(1).max(MAX_CARD_GROUPS).optional(),
    })
    .optional(),
  /** List: these fields of the first records, in this order. */
  list: z
    .object({
      fields: z.array(idField).max(8),
      sorts: z.array(sortSchema).max(MAX_SORTS).optional(),
      limit: z.number().int().min(1).max(MAX_CARD_LIST).optional(),
    })
    .optional(),
  size: z.enum(CARD_SIZES).optional(),
});
export type Card = z.infer<typeof cardSchema>;

/** What a view shows and how; every key is optional and a missing one has a sensible default. */
export const viewConfigSchema = z.object({
  filter: filterSchema.optional(),
  sorts: z.array(sortSchema).max(MAX_SORTS).optional(),
  /** Grid, gallery: rows in groups by this field. */
  group: viewGroupSchema.nullable().optional(),
  /** Field order; fields not listed follow in the table's order. */
  order: z.array(idField).max(MAX_FIELDS).optional(),
  hidden: z.array(idField).max(MAX_FIELDS).optional(),
  /** Grid column widths in pixels, by field id. */
  widths: z.record(idField, z.number().int().min(60).max(800)).optional(),
  /** Grid: how many columns after the primary one stay put while scrolling sideways. */
  frozen: z.number().int().min(0).max(5).optional(),
  row_height: z.enum(ROW_HEIGHTS).optional(),
  /** Kanban: one column per option of a single select, or per member of a single member field. */
  kanban: z.object({ field: idField, hide_empty: z.boolean().optional() }).optional(),
  /** Calendar: records on their start date, across to the end date when there is one. */
  calendar: z.object({ start: idField, end: idField.optional() }).optional(),
  /** Gallery: the first picture of an attachment field on top of each card. */
  gallery: z.object({ cover: idField.optional() }).optional(),
  /**
   * Timeline: bars from start to end, arrows from a dependency field, diamonds for milestones
   * (an option of a single select, or a checkbox that is on). Children follow their parent.
   */
  timeline: z
    .object({
      start: idField,
      end: idField.optional(),
      dependency: idField.optional(),
      milestone: z.object({ field: idField, option: z.string().max(64).optional() }).optional(),
      scale: z.enum(TIMELINE_SCALES).optional(),
    })
    .optional(),
  /** Dashboard: its cards, in order. */
  cards: z.array(cardSchema).max(MAX_CARDS).optional(),
});
export type ViewConfig = z.infer<typeof viewConfigSchema>;

export const viewSchema = z.object({
  id: z.string(),
  /** Null for a dashboard: it belongs to the base. */
  table_id: z.string().nullable(),
  name: z.string(),
  type: z.enum(VIEW_TYPES),
  /** Only I see it; shared views are everyone's who sees the base. */
  personal: z.boolean(),
  config: viewConfigSchema,
  position: z.number().int(),
  /** Send it back with a change; a newer one answers 409 `stale_revision`. */
  revision: z.number().int(),
  /** I may change it: my personal view, or a shared one when I build this base. */
  editable: z.boolean(),
});
export type View = z.infer<typeof viewSchema>;

export const createViewInputSchema = z.object({
  name: z.string().trim().min(1).max(VIEW_NAME_MAX),
  type: z.enum(TABLE_VIEW_TYPES),
  /** Shared views need builder access. */
  personal: z.boolean().default(false),
  /** Default: the type's settings filled in from the table's fields. */
  config: viewConfigSchema.optional(),
});
export type CreateViewInput = z.input<typeof createViewInputSchema>;
export const updateViewInputSchema = z.object({
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(VIEW_NAME_MAX).optional(),
  config: viewConfigSchema.optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});
export type UpdateViewInput = z.infer<typeof updateViewInputSchema>;

export const baseTableSchema = z.object({
  id: z.string(),
  base_id: z.string(),
  name: z.string(),
  description: z.string(),
  position: z.number().int(),
  /** Grows with every change to its fields; a field change names it (409 `stale_schema`). */
  schema_revision: z.number().int(),
  /** Live fields in the table's order, the primary one first (without those my role hides). */
  fields: z.array(fieldSchema),
  /** A custom role reads (`read`) or edits (`edit`) this table; absent for the four roles. */
  access: z.enum(['read', 'edit']).optional(),
});
export type BaseTable = z.infer<typeof baseTableSchema>;
export const createTableInputSchema = z.object({ name: z.string().trim().min(1).max(TABLE_NAME_MAX) });
export const updateTableInputSchema = z.object({
  name: z.string().trim().min(1).max(TABLE_NAME_MAX).optional(),
  description: z.string().max(2000).optional(),
  position: z.number().int().min(0).max(10_000).optional(),
});
export type UpdateTableInput = z.infer<typeof updateTableInputSchema>;

/** A base in my directory: its data tables and the views I see, without fields. */
export const baseSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  owner_id: z.string(),
  access: z.enum(BASE_ROLES),
  pinned: z.boolean(),
  template_key: z.string().nullable(),
  archived_at: isoTime.nullable(),
  updated_at: isoTime,
  tables: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      views: z.array(z.object({ id: z.string(), name: z.string(), type: z.enum(VIEW_TYPES), personal: z.boolean() })),
    }),
  ),
  /** Dashboards of the base. */
  dashboards: z.array(z.object({ id: z.string(), name: z.string(), personal: z.boolean() })),
  /** The custom role I have here, when that is all I have. */
  custom_role: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type BaseSummary = z.infer<typeof baseSummarySchema>;

export const baseSchema = baseSummarySchema.omit({ tables: true, dashboards: true }).extend({
  owner: memberRefSchema,
  created_at: isoTime,
  tables: z.array(baseTableSchema),
  /** Shared views and my personal ones, of every table, and the dashboards. */
  views: z.array(viewSchema),
  /** AI fields can be added: a model service is set up. */
  ai_fields: z.boolean(),
});
export type Base = z.infer<typeof baseSchema>;

export const baseListQuerySchema = z.object({
  archived: z.enum(['true', 'false']).default('false'),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
/** A page of my bases, by name; `next_cursor` for the next one. */
export const baseListSchema = z.object({ items: z.array(baseSummarySchema), next_cursor: z.string().nullable() });
export type BaseList = z.infer<typeof baseListSchema>;
export const createBaseInputSchema = z.object({
  /** Default: the template's name, or 未命名表格. */
  name: z.string().trim().min(1).max(BASE_NAME_MAX).optional(),
  description: z.string().max(2000).optional(),
  template: z.enum(BASE_TEMPLATES).optional(),
});
export type CreateBaseInput = z.infer<typeof createBaseInputSchema>;
export const updateBaseInputSchema = z.object({
  name: z.string().trim().min(1).max(BASE_NAME_MAX).optional(),
  description: z.string().max(2000).optional(),
  icon: z.string().max(40).optional(),
  /** Mine only: pinned bases come first in the directory. */
  pinned: z.boolean().optional(),
});
export type UpdateBaseInput = z.infer<typeof updateBaseInputSchema>;
/** Deleting a base for good: its name typed again. */
export const deleteBaseInputSchema = z.object({ name: z.string().max(BASE_NAME_MAX + 10) });

/** A share's role: one of the four, or `custom` with the custom role's id. */
export const SHARE_ROLES = [...BASE_ROLES, 'custom'] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export const baseShareSchema = z.object({
  type: z.enum(AUDIENCE_TYPES),
  /** Null for the workspace. */
  id: z.string().nullable(),
  /** The member's or group's name; empty for the workspace. */
  name: z.string(),
  role: z.enum(SHARE_ROLES),
  custom_role_id: z.string().nullable(),
});
export type BaseShare = z.infer<typeof baseShareSchema>;
export const baseSharesSchema = z.object({ owner: memberRefSchema, items: z.array(baseShareSchema) });
export type BaseShares = z.infer<typeof baseSharesSchema>;
/** Replaces the base's shares. Members can be any role; groups and the workspace only editor or viewer. */
export const baseShareInputSchema = z.object({
  items: z
    .array(
      z
        .object({
          type: z.enum(AUDIENCE_TYPES),
          id: idField.optional(),
          role: z.enum(SHARE_ROLES),
          custom_role_id: idField.optional(),
        })
        .refine((entry) => (entry.type === 'workspace') === (entry.id === undefined), {
          message: 'A member or group needs its id; the workspace has none.',
        })
        .refine(
          (entry) =>
            entry.type === 'member' ||
            entry.role === 'custom' ||
            (GROUP_SHARE_ROLES as readonly string[]).includes(entry.role),
          { message: 'Groups and the workspace can edit or view, not build or own.' },
        )
        .refine((entry) => (entry.role === 'custom') === (entry.custom_role_id !== undefined), {
          message: 'A custom role needs its id, and only a custom role has one.',
        }),
    )
    .max(200),
});
export type BaseShareInput = z.infer<typeof baseShareInputSchema>;

/** Values by field id (see the top of this file for the shape of each type). */
export const recordValuesSchema = z.record(idField, z.unknown());
export type RecordValues = z.infer<typeof recordValuesSchema>;

export const recordSchema = z.object({
  id: z.string(),
  table_id: z.string(),
  /** Stored and computed values by field id, without the fields my role hides. */
  values: recordValuesSchema,
  revision: z.number().int(),
  /** Moves when computed values change (a write's revision does not). */
  computed_revision: z.number().int(),
  created_by: z.string().nullable(),
  created_at: isoTime,
  updated_by: z.string().nullable(),
  updated_at: isoTime,
});
export type TableRecord = z.infer<typeof recordSchema>;

/** A linked record's title (its primary field), for showing a link without loading the record. */
export const linkedRecordSchema = z.object({ title: z.string(), table_id: z.string() });
export type LinkedRecord = z.infer<typeof linkedRecordSchema>;
/** A file in an attachment field, with a URL signed for the reader for an hour or two. */
export const recordFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int(),
  url: z.string(),
});
export type RecordFile = z.infer<typeof recordFileSchema>;

export const recordsQuerySchema = z.object({
  filter: filterSchema.optional(),
  sorts: z.array(sortSchema).max(MAX_SORTS).optional(),
  /** Records of a group come together; it sorts before `sorts`. */
  group: viewGroupSchema.nullable().optional(),
  /** Text the text fields contain. */
  search: z.string().trim().max(200).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).default(200),
  /** Also count every record that matches (`total`). */
  count: z.boolean().optional(),
});
export type RecordsQuery = z.input<typeof recordsQuerySchema>;

export const recordPageSchema = z.object({
  items: z.array(recordSchema),
  next_cursor: z.string().nullable(),
  total: z.number().int().optional(),
  /** Titles of the records the page links to, by id. */
  linked: z.record(z.string(), linkedRecordSchema),
  /** The page's attachments, by file id. */
  files: z.record(z.string(), recordFileSchema),
});
export type RecordPage = z.infer<typeof recordPageSchema>;

export const recordDetailSchema = z.object({
  record: recordSchema,
  base_id: z.string(),
  table_id: z.string(),
  linked: z.record(z.string(), linkedRecordSchema),
  files: z.record(z.string(), recordFileSchema),
  /** Records whose parent field names this one. */
  children: z.array(z.object({ id: z.string(), title: z.string() })),
});
export type RecordDetail = z.infer<typeof recordDetailSchema>;

export const createRecordInputSchema = z.object({ values: recordValuesSchema.default({}) });
export type CreateRecordInput = z.input<typeof createRecordInputSchema>;
export const updateRecordInputSchema = z.object({
  /** The revision this change is based on. */
  revision: z.number().int().positive(),
  values: recordValuesSchema,
});
export type UpdateRecordInput = z.infer<typeof updateRecordInputSchema>;

/** A paste: changes to existing records (with or without their revision) and new ones, each on its own. */
export const bulkRecordsInputSchema = z.object({
  items: z
    .array(
      z.object({
        id: idField.optional(),
        revision: z.number().int().positive().optional(),
        values: recordValuesSchema,
      }),
    )
    .min(1)
    .max(MAX_BULK),
});
export type BulkRecordsInput = z.infer<typeof bulkRecordsInputSchema>;
export const bulkResultSchema = z.object({
  items: z.array(
    z.object({
      ok: z.boolean(),
      record: recordSchema.optional(),
      /** Why this one failed: `stale_revision`, `not_found`, `invalid_input`. */
      code: z.string().optional(),
      message: z.string().optional(),
    }),
  ),
  linked: z.record(z.string(), linkedRecordSchema),
  files: z.record(z.string(), recordFileSchema),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;
export const recordIdsInputSchema = z.object({ ids: z.array(idField).min(1).max(MAX_BULK) });
export type RecordIdsInput = z.infer<typeof recordIdsInputSchema>;

export const titlesQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export const recordTitleSchema = z.object({ id: z.string(), title: z.string() });
export type RecordTitle = z.infer<typeof recordTitleSchema>;

export const RECORD_EVENT_TYPES = ['created', 'updated', 'deleted', 'restored'] as const;
export const recordEventSchema = z.object({
  kind: z.literal('event'),
  id: z.string(),
  type: z.enum(RECORD_EVENT_TYPES),
  actor: z.object({ type: z.string(), id: z.string().nullable(), name: z.string() }),
  /** Updates: what changed, with the field's name now (or when it was deleted). */
  changes: z.array(z.object({ field: z.string(), name: z.string(), before: z.unknown(), after: z.unknown() })),
  created_at: isoTime,
});
export type RecordEvent = z.infer<typeof recordEventSchema>;
export const recordActivityItemSchema = z.discriminatedUnion('kind', [
  recordEventSchema,
  commentSchema.extend({ kind: z.literal('comment') }),
]);
export type RecordActivityItem = z.infer<typeof recordActivityItemSchema>;
/** Comments and changes, newest first. */
export const recordActivitySchema = z.object({
  items: z.array(recordActivityItemSchema),
  next_cursor: z.string().nullable(),
  linked: z.record(z.string(), linkedRecordSchema),
});
export type RecordActivity = z.infer<typeof recordActivitySchema>;

export const TRASH_KINDS = ['record', 'field', 'table'] as const;
export const trashItemSchema = z.object({
  kind: z.enum(TRASH_KINDS),
  id: z.string(),
  /** A record's title, a field's or a table's name. */
  name: z.string(),
  table_id: z.string(),
  table_name: z.string(),
  deleted_at: isoTime,
  deleted_by: memberRefSchema.nullable(),
});
export type TrashItem = z.infer<typeof trashItemSchema>;

// ── Custom roles ──

export const roleTableRulesSchema = z.object({
  access: z.enum(ROLE_TABLE_ACCESS),
  /** Only the records this filter keeps (`$me` is the reader); none: every record. */
  rows: filterSchema.nullable().optional(),
  /** Fields the role does not see: not in lists, records, search, exports or history. */
  hidden_fields: z.array(idField).max(MAX_FIELDS).optional(),
});
export type RoleTableRules = z.infer<typeof roleTableRulesSchema>;
export const roleRulesSchema = z.object({ tables: z.record(idField, roleTableRulesSchema) });
export type RoleRules = z.infer<typeof roleRulesSchema>;

export const baseRoleSchema = z.object({
  id: z.string(),
  base_id: z.string(),
  name: z.string(),
  description: z.string(),
  rules: roleRulesSchema,
  position: z.number().int(),
  revision: z.number().int(),
});
export type BaseCustomRole = z.infer<typeof baseRoleSchema>;
export const baseRolesSchema = z.object({ items: z.array(baseRoleSchema) });
export const createRoleInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).optional(),
  rules: roleRulesSchema.default({ tables: {} }),
});
export type CreateRoleInput = z.input<typeof createRoleInputSchema>;
/** AI fields filled in again for these records now (editors; the model is metered to them). */
export const generateInputSchema = z.object({ record_ids: z.array(idField).min(1).max(100) });
export type GenerateInput = z.infer<typeof generateInputSchema>;
export const updateRoleInputSchema = z.object({
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().max(500).optional(),
  rules: roleRulesSchema.optional(),
  position: z.number().int().min(0).max(1000).optional(),
});
export type UpdateRoleInput = z.infer<typeof updateRoleInputSchema>;

export const baseAuditEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  actor: memberRefSchema.nullable(),
  summary: z.string(),
  created_at: isoTime,
});
export type BaseAuditEntry = z.infer<typeof baseAuditEntrySchema>;
