/**
 * Tables application shared wire contracts.
 *
 * These are deliberately transport-neutral. Database rows stay inferred in
 * @greenhouse/db; REST, Web, Agent Proxy, and MCP share only the dynamic-field
 * values and bounded query/dashboard contracts defined here.
 */

export const TABLE_FIELD_TYPES = [
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
  'lookup',
] as const;

export type TableFieldType = (typeof TABLE_FIELD_TYPES)[number];

/**
 * Field types whose value is derived, never written. Every "is this writable /
 * may a form or import target it / render read-only" decision references this
 * one list (Phase 2 adds `ai`).
 */
export const COMPUTED_FIELD_TYPES = ['formula', 'rollup', 'lookup'] as const;
export type TableComputedFieldType = (typeof COMPUTED_FIELD_TYPES)[number];

export function isComputedFieldType(type: TableFieldType): type is TableComputedFieldType {
  return (COMPUTED_FIELD_TYPES as readonly string[]).includes(type);
}

/**
 * Columns every record has, addressable in filters, sorts, grouping and display
 * lists alongside user fields (`created_by` is how "my requests" is expressed).
 */
export const TABLE_SYSTEM_FIELDS = ['created_by', 'created_at', 'updated_at', 'updated_by'] as const;
export type TableSystemField = (typeof TABLE_SYSTEM_FIELDS)[number];

export interface TableSelectOption {
  /** Stable option identifier stored in records. */
  id: string;
  label: string;
  color?: string;
}

export const TABLE_FORMULA_BINARY_OPERATORS = [
  'add',
  'subtract',
  'multiply',
  'divide',
  'concat',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'and',
  'or',
] as const;
export type TableFormulaBinaryOperator = (typeof TABLE_FORMULA_BINARY_OPERATORS)[number];

/** Function names a formula AST may call. Arity and typing live in `./table-formula` (`TABLE_FORMULA_FUNCTION_CATALOG`). */
export const TABLE_FORMULA_FUNCTIONS = [
  'if',
  'coalesce',
  'concat',
  'round',
  'upper',
  'lower',
  'abs',
  'floor',
  'ceil',
  'min',
  'max',
  'mod',
  'len',
  'trim',
  'left',
  'right',
  'contains',
  'and',
  'or',
  'not',
  'year',
  'month',
  'day',
  'datediff',
  'dateadd',
] as const;
export type TableFormulaFunction = (typeof TABLE_FORMULA_FUNCTIONS)[number];

export type TableFormulaExpression =
  | { type: 'literal'; value: string | number | boolean | null }
  | { type: 'field'; fieldId: number }
  | {
      type: 'binary';
      operator: TableFormulaBinaryOperator;
      left: TableFormulaExpression;
      right: TableFormulaExpression;
    }
  | { type: 'function'; name: TableFormulaFunction; args: TableFormulaExpression[] };

export type TableFormulaResultType = 'text' | 'number' | 'boolean' | 'date' | 'datetime';
export type TableRollupAggregation = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'join';

export interface TableFieldConfig {
  version?: number;
  options?: TableSelectOption[];
  relation?: {
    targetTableId: number;
    multiple?: boolean;
  };
  formula?: {
    resultType: TableFormulaResultType;
    expression: TableFormulaExpression;
  };
  rollup?: {
    relationFieldId: number;
    targetFieldId: number;
    aggregation: TableRollupAggregation;
  };
  /** The linked records' values of one target field, as an array (computed). */
  lookup?: {
    relationFieldId: number;
    targetFieldId: number;
  };
}

/**
 * A `{fieldId, value}` pair. Used instead of a field-id-keyed object wherever a
 * plan may reference a field it creates (`"$field:<ref>"` must fit), and for
 * stable ordering in editors.
 */
export interface TableFieldValueEntry {
  fieldId: number;
  value: unknown;
}

export type TableRecordValues = Record<string, unknown>;

export const TABLE_FILTER_OPERATORS = [
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
  'in',
] as const;

export type TableFilterOperator = (typeof TABLE_FILTER_OPERATORS)[number];

/**
 * One predicate. Exactly one of `fieldId` / `systemField` is set. Values may be
 * parameter tokens (`$me` on user / created_by / updated_by clauses; `$today`,
 * `$today-7d`, `$today+3d`, `$now`, `$week_start`, `$month_start` on date
 * clauses) — expanded by the single SQL compiler, never by callers.
 */
export type TableFilterClause =
  | { fieldId: number; systemField?: undefined; operator: TableFilterOperator; value?: unknown }
  | { systemField: TableSystemField; fieldId?: undefined; operator: TableFilterOperator; value?: unknown };

export interface TableFilterGroup {
  combinator: 'and' | 'or';
  clauses: TableFilterClause[];
}

export interface TableSort {
  fieldId?: number;
  systemField?: TableSystemField;
  direction: 'asc' | 'desc';
}

/** Grouping key for grid group-by and aggregates. Exactly one of fieldId / systemField. */
export interface TableGroupBy {
  fieldId?: number;
  systemField?: TableSystemField;
  direction?: 'asc' | 'desc';
}

export interface TableQuery {
  where?: TableFilterGroup;
  /**
   * Extra groups ANDed with `where` (≤ 5): dashboard / page filter controls,
   * drill-down and app parameters add predicates here instead of nesting.
   */
  filters?: TableFilterGroup[];
  search?: string;
  sort?: TableSort[];
  /** Applied before `sort`; does not count toward the sort limit. */
  groupBy?: TableGroupBy;
  /** Opaque cursor returned by a previous query with the same filters/sort. */
  cursor?: string;
  limit?: number;
}

/** The four built-in Base roles. A member row may instead hold `custom` (see `./table-access`). */
export type TableBaseRole = 'owner' | 'builder' | 'editor' | 'viewer';
export type TableBaseVisibility = 'private' | 'team';
export type TableViewScope = 'shared' | 'personal';

export const TABLE_VIEW_TYPES = ['grid', 'kanban', 'calendar', 'gallery'] as const;
export type TableViewType = (typeof TABLE_VIEW_TYPES)[number];

export interface TableViewConfig {
  version?: number;
  /** Visible user fields, in display order (grid columns; card fields for kanban / calendar / gallery). */
  fieldIds?: number[];
  /** Visible system columns, shown after `fieldIds`. */
  systemFields?: TableSystemField[];
  widths?: Record<string, number>;
  /**
   * How many leading columns stay pinned to the left while scrolling.
   * A contiguous prefix rather than an arbitrary set of columns: anything else
   * fights with column order and the cumulative offsets used to place them.
   */
  frozenCount?: number;
  query?: Omit<TableQuery, 'cursor' | 'limit'>;
  /** Grid only: group rows by this key (collapsible group headers). */
  groupBy?: TableGroupBy;
  /** Kanban: one lane per option (single_select) or per user (user), plus "no value". */
  kanban?: { groupFieldId: number; coverFieldId?: number; hiddenGroups?: string[] };
  /** Calendar: records placed by a date / datetime field, optionally spanning to an end field. */
  calendar?: { startFieldId: number; endFieldId?: number };
  /** Gallery: cover image from the first image in an attachment field. */
  gallery?: { coverFieldId?: number; fit?: 'cover' | 'contain' };
  rowHeight?: 'short' | 'medium' | 'tall';
}

/** Stored widget `type` values. New widgets mirror their `TableCardSpec` (see `./table-cards`). */
export const TABLE_DASHBOARD_WIDGET_TYPES = ['kpi', 'bar', 'line', 'pie', 'area', 'pivot', 'records', 'text'] as const;
export type TableDashboardWidgetType = (typeof TABLE_DASHBOARD_WIDGET_TYPES)[number];

export const TABLE_AGGREGATIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type TableAggregation = (typeof TABLE_AGGREGATIONS)[number];

// ─── Cards (dashboards now, app pages in Phase 1) ─────────

/**
 * The one card specification. Dashboard widgets store it (`config.card`) and
 * app cards embed it, so both are evaluated by the same server evaluator and
 * drawn by the same components. Pure helpers live in `./table-cards`.
 */
export interface TableCardSpec {
  kind: 'kpi' | 'chart' | 'pivot' | 'records' | 'text';
  source?: { tableId: number; query?: Omit<TableQuery, 'cursor' | 'limit'> };
  aggregate?: {
    operation: TableAggregation;
    valueFieldId?: number;
    groupBy?: { fieldId?: number; systemField?: TableSystemField; dateBucket?: TableDateBucket };
    series?: { fieldId?: number; systemField?: TableSystemField };
    sort?: 'value_desc' | 'value_asc' | 'group_asc' | 'group_desc';
    limit?: number;
  };
  chart?: {
    type: 'bar' | 'line' | 'area' | 'pie';
    stacked?: boolean;
    horizontal?: boolean;
    donut?: boolean;
    showValues?: boolean;
  };
  /** records: columns. */
  fieldIds?: number[];
  systemFields?: TableSystemField[];
  /** text: markdown body (≤ 100k). */
  markdown?: string;
  /** records: rows per page (≤ 100). */
  limit?: number;
}

export type TableFilterControlKind = 'date_range' | 'select' | 'user' | 'search';

/** A viewer-controlled filter on a dashboard (and, in Phase 1, an app page). */
export interface TableFilterControl {
  id: string;
  label: string;
  kind: TableFilterControlKind;
  /** The fields this control filters, per table. A target the viewer cannot read is dropped for that viewer. */
  targets: Array<{ tableId: number; fieldId?: number; systemField?: TableSystemField }>;
  defaultValue?: TableFilterValue;
}

export type TableDateRangePreset =
  | 'today'
  | 'last_7_days'
  | 'last_30_days'
  | 'this_week'
  | 'this_month'
  | 'this_quarter'
  | 'this_year';

export type TableFilterValue =
  | { kind: 'date_range'; preset?: TableDateRangePreset; from?: string; to?: string }
  | { kind: 'select'; values: string[] }
  | { kind: 'user'; userIds: string[] }
  | { kind: 'search'; text: string };

export interface TableDashboardConfig {
  version?: number;
  filters?: TableFilterControl[];
}

/**
 * Stored widget config. New and normalized widgets carry `card` (the unified
 * `TableCardSpec` shared with app cards); the flat legacy fields are read for
 * compatibility and mapped onto a card spec by the server normalizer.
 */
export interface TableDashboardWidgetConfig {
  version?: number;
  card?: TableCardSpec;
  /** @deprecated legacy flat config — read only, mapped onto `card`. */
  operation?: TableAggregation;
  /** @deprecated */
  valueFieldId?: number;
  /** @deprecated */
  groupByFieldId?: number;
  /** @deprecated */
  query?: Omit<TableQuery, 'cursor' | 'limit'>;
  /** @deprecated */
  limit?: number;
  /** @deprecated */
  text?: string;
}

export interface TableDashboardWidgetLayout {
  version?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const TABLE_SCHEMA_CHANGE_TYPES = ['created', 'field_created', 'field_updated', 'field_archived'] as const;
export type TableSchemaChangeType = (typeof TABLE_SCHEMA_CHANGE_TYPES)[number];

export interface TableSchemaSnapshotField {
  id: number;
  name: string;
  type: TableFieldType;
  required: boolean;
  isPrimary: boolean;
  config: TableFieldConfig;
  position: number;
  archivedAt: string | null;
}

export interface TableSchemaSnapshot {
  version: 1;
  tableId: number;
  fields: TableSchemaSnapshotField[];
}

export interface TableBatchValidationResult {
  index: number;
  ok: boolean;
  reason?: 'not_found' | 'conflict' | 'invalid';
  message?: string;
  current?: number;
}

/** Who may open and submit a form. `base` = today's behaviour (Base members with create rights). */
export type TableFormAudience =
  | { type: 'base' }
  | { type: 'team' }
  | { type: 'principals'; userIds: string[]; groupIds: number[] };

export interface TableFormConfig {
  version?: number;
  title?: string;
  description?: string;
  fieldIds: number[];
  submitLabel?: string;
  successMessage?: string;
  /** Hidden prefilled values; may use `$me` / `$today` / `$now`, resolved and locked server-side. */
  defaults?: TableFieldValueEntry[];
  /** Default true. False = one submission per user (enforced by a unique index). */
  allowMultiple?: boolean;
}

/** Public, submit-side view of a form (no Base data). */
export interface TableFormSubmitView {
  id: number;
  name: string;
  title: string;
  description: string | null;
  submitLabel: string | null;
  successMessage: string | null;
  fields: Array<{
    id: number;
    name: string;
    type: TableFieldType;
    required: boolean;
    options?: TableSelectOption[];
  }>;
  /** Internal user directory, present when the form has user fields. */
  userOptions?: Array<{ id: string; name: string }>;
  alreadySubmitted: boolean;
}

export const TABLE_AUTOMATION_TRIGGERS = [
  'record_created',
  'record_updated',
  'record_matched',
  'schedule',
  'date_reached',
  'button',
] as const;
export type TableAutomationTrigger = (typeof TABLE_AUTOMATION_TRIGGERS)[number];

export type TableNotifyChannel = 'inbox' | 'im' | 'email';

/** Recipients are always internal users — never free-form addresses. */
export interface TableAutomationRecipients {
  userIds?: string[];
  groupIds?: number[];
  userFieldIds?: number[];
  creator?: boolean;
  /** The member whose write triggered the rule (absent for schedule / date triggers). */
  actor?: boolean;
}

/**
 * Actions carry a stable `id`, assigned by the server normalizer and never
 * regenerated: the delivery dedupe key, the resume cursor and the webhook secret
 * are all keyed by it. `update_record` / `create_record` values may use `$now`,
 * `$today`, `$actor` and `{{field:<id>}}` templates (text-like fields).
 */
export type TableAutomationAction =
  | { id: string; type: 'update_record'; values: TableFieldValueEntry[] }
  | { id: string; type: 'create_record'; tableId: number; values: TableFieldValueEntry[] }
  | {
      id: string;
      type: 'notify';
      recipients: TableAutomationRecipients;
      /** Supports `{{field:<id>}}`, rendered per recipient against what that recipient may read. */
      title: string;
      message: string;
      channels?: TableNotifyChannel[];
      urgent?: boolean;
    }
  | { id: string; type: 'webhook'; url: string; fieldIds?: number[]; hasSecret?: boolean }
  | { id: string; type: 'delay'; minutes: number };

export type TableAutomationActionType = TableAutomationAction['type'];

/** Input shape: ids are optional (the server assigns them); a webhook may set or clear its secret (UI route only). */
export type TableAutomationActionInput =
  | (Omit<Extract<TableAutomationAction, { type: 'webhook' }>, 'id' | 'hasSecret'> & {
      id?: string;
      secret?: string | null;
    })
  | (Omit<Extract<TableAutomationAction, { type: 'update_record' }>, 'id'> & { id?: string })
  | (Omit<Extract<TableAutomationAction, { type: 'create_record' }>, 'id'> & { id?: string })
  | (Omit<Extract<TableAutomationAction, { type: 'notify' }>, 'id'> & { id?: string })
  | (Omit<Extract<TableAutomationAction, { type: 'delay' }>, 'id'> & { id?: string });

export interface TableAutomationConfig {
  version?: number;
  condition?: TableFilterGroup;
  /** record_updated: fire only when one of these fields changed. */
  watchFieldIds?: number[];
  /** schedule: `once` per occurrence, or `records` = once per record matching `condition` (≤ 200). */
  schedule?: { cron: string; timezone: string; scope: 'once' | 'records' };
  /** date_reached: date field + offset; for datetime fields the offset applies to the instant and `time` is ignored. */
  dateTrigger?: { fieldId: number; offsetDays: number; time: string; timezone: string };
  /** button: label shown on records. */
  buttonLabel?: string;
  actions: TableAutomationAction[];
}

export interface TableAutomationRunStep {
  actionId: string;
  type: TableAutomationActionType;
  status: 'succeeded' | 'failed' | 'skipped';
  /** What happened, as a stable code the client words (`params` fill it in). */
  code?: TableAutomationStepCode;
  params?: Record<string, string | number>;
  /** Raw detail (an HTTP status line, a validation error) shown as-is. */
  message?: string;
  at: string;
}

export type TableAutomationStepCode =
  | 'record_updated'
  | 'record_created'
  | 'notified'
  | 'webhook_sent'
  | 'webhook_retrying'
  | 'delayed'
  | 'failed';

/**
 * Why a run did not finish, stored in `table_automation_runs.error` (anything
 * else there is a raw message): the rule changed while the run waited, its
 * executor is no longer a builder, its record or table is gone, or 0024 closed
 * a run of the old synchronous executor.
 */
export const TABLE_AUTOMATION_RUN_ERRORS = [
  'rule_changed',
  'executor_not_builder',
  'record_unavailable',
  'table_unavailable',
  'legacy_sync_executor',
] as const;
export type TableAutomationRunError = (typeof TABLE_AUTOMATION_RUN_ERRORS)[number];

export type TableAutomationSchedule = NonNullable<TableAutomationConfig['schedule']>;
export type TableAutomationDateTrigger = NonNullable<TableAutomationConfig['dateTrigger']>;

/** A run is `running` while it waits on a delay or a retry; `canceled` = the rule changed, or its executor lost builder access. */
export const TABLE_AUTOMATION_RUN_STATUSES = ['running', 'succeeded', 'failed', 'canceled'] as const;
export type TableAutomationRunStatus = (typeof TABLE_AUTOMATION_RUN_STATUSES)[number];

/** Limits the server enforces and the editor quotes. */
export const TABLE_AUTOMATION_LIMITS = {
  actions: 10,
  /** schedule: nothing fires more often than this. */
  minScheduleIntervalMinutes: 15,
  /** schedule scope `records`: at most this many records per occurrence. */
  scheduleRecords: 200,
  delayMinutes: 1440,
  dateOffsetDays: 365,
  buttonLabel: 40,
  notifyTitle: 120,
  notifyMessage: 2_000,
  webhookUrl: 2_000,
  webhookSecretMin: 16,
  webhookSecretMax: 256,
} as const;

/**
 * Value tokens an `update_record` / `create_record` value may be, whole:
 * `$now` (the run's instant), `$today` (its date in the rule's time zone),
 * `$actor` (the member whose write or click triggered the run).
 */
export const TABLE_AUTOMATION_VALUE_TOKENS = ['$now', '$today', '$actor'] as const;
export type TableAutomationValueToken = (typeof TABLE_AUTOMATION_VALUE_TOKENS)[number];

/** `{{field:<id>}}` — a field of the triggering record, in action values and notify / webhook text. */
export const TABLE_AUTOMATION_FIELD_TEMPLATE = /\{\{field:(\d+)\}\}/g;

/** The field ids a template string references, in order of first use. */
export function automationTemplateFieldIds(text: string): number[] {
  const ids: number[] = [];
  for (const match of text.matchAll(TABLE_AUTOMATION_FIELD_TEMPLATE)) {
    const id = Number(match[1]);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Which triggers run with a record, and which with the member who caused them. */
export function automationTriggerHasRecord(
  trigger: TableAutomationTrigger,
  schedule?: TableAutomationConfig['schedule'],
): boolean {
  return trigger !== 'schedule' || schedule?.scope === 'records';
}

export function automationTriggerHasActor(trigger: TableAutomationTrigger): boolean {
  return (
    trigger === 'record_created' || trigger === 'record_updated' || trigger === 'record_matched' || trigger === 'button'
  );
}

export interface TableAggregateInput {
  operation: TableAggregation;
  valueFieldId?: number;
  /** @deprecated use `groupBy` */
  groupByFieldId?: number;
  groupBy?: TableGroupBy & { dateBucket?: TableDateBucket };
  /** Second dimension (stacked / multi-series / pivot columns). */
  series?: { fieldId?: number; systemField?: TableSystemField };
  query?: Omit<TableQuery, 'cursor' | 'limit'>;
  sort?: 'value_desc' | 'value_asc' | 'group_asc' | 'group_desc';
  limit?: number;
  /** IANA zone used for date bucketing and date tokens. Default UTC. */
  timezone?: string;
}

export const TABLE_DATE_BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type TableDateBucket = (typeof TABLE_DATE_BUCKETS)[number];

export interface TableAggregateRow {
  group: string | number | boolean | null;
  series?: string | number | boolean | null;
  value: number;
}

// ─── Record writes, history, comments ────────────────────

export const TABLE_RECORD_ACTOR_KINDS = ['user', 'agent', 'automation', 'form', 'import', 'app', 'system'] as const;
export type TableRecordActorKind = (typeof TABLE_RECORD_ACTOR_KINDS)[number];

export interface TableRecordWriteSource {
  formId?: number;
  importId?: string;
  ruleId?: number;
  appId?: number;
  /** For automation writes: the rule's execution user (the actor is the rule). */
  executorId?: string;
}

/**
 * Required on every record write. Recorded in the record's history and decides
 * whether the write enqueues automations (imports and automations' own writes
 * do not — no chaining, no notification storms).
 */
export interface TableRecordWriteMeta {
  actorId: string;
  actorKind: TableRecordActorKind;
  source?: TableRecordWriteSource;
  enqueueAutomations: boolean;
}

export type TableRecordEventType = 'created' | 'updated' | 'deleted' | 'restored';

export interface TableRecordFieldChange {
  fieldId: number;
  before: unknown;
  after: unknown;
}

export interface TableRecordEventView {
  kind: 'event';
  id: number;
  recordId: number;
  actorId: string | null;
  actorKind: TableRecordActorKind;
  type: TableRecordEventType;
  changes: TableRecordFieldChange[];
  meta: TableRecordWriteSource;
  createdAt: string;
}

export interface TableRecordCommentView {
  kind: 'comment';
  id: number;
  recordId: number;
  authorId: string;
  body: string;
  mentions: string[];
  createdAt: string;
  updatedAt: string;
  edited: boolean;
}

export type TableRecordActivityItem = TableRecordEventView | TableRecordCommentView;

export interface TableRecordActivityPage {
  items: TableRecordActivityItem[];
  nextCursor: string | null;
}

/** A record's automation buttons the caller may press (no rule configuration exposed). */
export interface TableRecordButton {
  ruleId: number;
  label: string;
}

// ─── Import ───────────────────────────────────────────────

export interface TableImportColumn {
  index: number;
  header: string;
  samples: string[];
  inferredType: TableFieldType;
  suggestion?: { fieldId: number } | { create: { name: string; type: TableFieldType } };
}

export interface TableImportPreview {
  importId: string;
  fileName: string;
  rowCount: number;
  columns: TableImportColumn[];
  expiresAt: string;
}

export type TableImportMapping =
  | { column: number; fieldId: number }
  | { column: number; create: { name: string; type: TableFieldType } };

export interface TableImportCommitInput {
  importId: string;
  mapping: TableImportMapping[];
  hasHeader: boolean;
  /** Builders only: add missing select options instead of failing those cells. */
  createOptions?: boolean;
}

export interface TableImportResult {
  created: number;
  failed: Array<{ row: number; errors: string[] }>;
  createdFieldIds: number[];
}

// ─── Conversational schema editing ───────────────────────
//
// The `tables_schema_plan` tool drafts these; it writes nothing. They are
// applied only by POST /api/tables/schema-plan/apply, which the user reaches
// by pressing Confirm on the plan card — the model has no route to it.

/**
 * A plan-local identifier for an object this same plan creates, so a plan can
 * say "add these fields to the table I'm about to create". Never a database id.
 */
export type SchemaPlanRef = string;

export type SchemaPlanOperation =
  | {
      op: 'base.create';
      ref: SchemaPlanRef;
      name: string;
      description?: string;
      visibility?: TableBaseVisibility;
      /**
       * Creating a Base always creates one table with it. Naming it here (and
       * optionally giving it a ref) is how a plan uses that table instead of
       * leaving a stray empty "Table 1" beside the tables it really wanted.
       */
      defaultTableRef?: SchemaPlanRef;
      defaultTableName?: string;
    }
  | {
      op: 'base.update';
      baseId: number;
      name?: string;
      description?: string | null;
      visibility?: TableBaseVisibility;
    }
  | {
      op: 'table.create';
      ref?: SchemaPlanRef;
      /** Exactly one of baseRef / baseId. */
      baseRef?: SchemaPlanRef;
      baseId?: number;
      name: string;
      description?: string;
    }
  | { op: 'table.update'; tableId: number; name?: string; description?: string | null }
  | {
      op: 'field.create';
      /** Exactly one of tableRef / tableId. */
      tableRef?: SchemaPlanRef;
      tableId?: number;
      name: string;
      type: TableFieldType;
      required?: boolean;
      config?: TableFieldConfig;
    }
  | {
      op: 'field.update';
      /** Carried for the draft-time permission probe and to prove the field really is in this table. */
      tableId: number;
      fieldId: number;
      name?: string;
      required?: boolean;
      config?: TableFieldConfig;
    }
  | { op: 'field.archive'; tableId: number; fieldId: number };

export type SchemaPlanOperationKind = SchemaPlanOperation['op'];

/** Tool output rendered by the web plan card. Contains no ids of its own — the plan was never persisted. */
export interface TablesSchemaPlanArtifact {
  type: 'tables_schema_plan';
  /** One line in the user's language, shown under the card title. */
  summary: string;
  operations: SchemaPlanOperation[];
}

export type SchemaPlanResultStatus = 'applied' | 'failed' | 'skipped';

export interface SchemaPlanOperationResult {
  /** Index into the submitted operations array. */
  index: number;
  op: SchemaPlanOperationKind;
  status: SchemaPlanResultStatus;
  /** Id of the created or touched object, when one exists. */
  id?: number;
  /** Failure reason, or which ref's failure caused this one to be skipped. */
  message?: string;
}

export interface SchemaPlanApplyResult {
  results: SchemaPlanOperationResult[];
  /** The Base the plan touched, when it is unambiguous — lets the card link to it. */
  baseId?: number;
}
