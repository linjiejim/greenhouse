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
 * Field types a lookup may show: values that read as themselves (select
 * options as their labels). People, files and record ids would show raw ids,
 * and a rollup / lookup target would go stale (cascades are one level deep).
 */
export const TABLE_LOOKUP_TARGET_TYPES = [
  'text',
  'long_text',
  'number',
  'boolean',
  'date',
  'datetime',
  'single_select',
  'multi_select',
  'url',
  'email',
  'phone',
  'formula',
] as const satisfies readonly TableFieldType[];

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

export const TABLE_VIEW_ROW_HEIGHTS = ['short', 'medium', 'tall'] as const satisfies ReadonlyArray<
  NonNullable<TableViewConfig['rowHeight']>
>;

/**
 * The lane (kanban `hiddenGroups`) / group key of records with no value in the
 * grouping field. Every other key is the value as text: an option id, a user id.
 */
export const TABLE_VIEW_NO_VALUE_GROUP = '';

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
  /**
   * Hidden prefilled values; may use `$me` / `$today` / `$now`
   * (`TABLE_FORM_DEFAULT_TOKENS`), resolved and locked server-side. A field is
   * either shown (`fieldIds`) or prefilled, never both.
   */
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
    /** Relation fields (Base audiences only): accepts several record ids. */
    multiple?: boolean;
  }>;
  /** Internal user directory, present when the form has user fields. */
  userOptions?: Array<{ id: string; name: string; email?: string }>;
  alreadySubmitted: boolean;
  /** False = one submission per person; the page offers no "submit another". */
  allowMultiple: boolean;
}

/**
 * Tokens a form default may hold, resolved on the server at submit time:
 * `$me` → the submitter (user / multi-user fields), `$today` → the submit day in
 * the submitter's time zone (date fields), `$now` → the submit instant
 * (datetime fields). Anything else is a static value.
 */
export const TABLE_FORM_DEFAULT_TOKENS = ['$me', '$today', '$now'] as const;
export type TableFormDefaultToken = (typeof TABLE_FORM_DEFAULT_TOKENS)[number];

/** `POST /api/forms/:id/uploads` — a file staged for this form, bound when the same person submits. */
export interface TableFormUploadView {
  id: number;
  name: string;
  size: number;
}

/** `POST /api/forms/:id/submit` — the record is never echoed back. */
export interface TableFormSubmitResult {
  submitted: true;
  successMessage: string | null;
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
  /** What the caller may do on this record's activity (set by `listRecordActivity`). */
  viewer?: TableRecordActivityViewer;
}

/** Comment bodies are Markdown, at most this many characters (mention links included). */
export const TABLE_COMMENT_MAX_LENGTH = 10_000;
/** `listRecordActivity` page size: default and ceiling. */
export const TABLE_ACTIVITY_PAGE_SIZE = 30;
export const TABLE_ACTIVITY_MAX_PAGE_SIZE = 50;

export interface TableRecordActivityViewer {
  /** The effective user — the author id a client compares to offer "edit / delete my comment". */
  userId: string;
  /** May post (and, as author, edit / delete) comments here. */
  canComment: boolean;
  /** May delete anyone's comment (Base builder+). */
  canModerate: boolean;
}

/** A record's automation buttons the caller may press (no rule configuration exposed). */
export interface TableRecordButton {
  ruleId: number;
  label: string;
}

// ─── Import ───────────────────────────────────────────────

/**
 * Types an import may give a field it creates for a column. Relations need a
 * target table and attachments are never imported; computed types are derived.
 */
export const TABLE_IMPORT_CREATABLE_FIELD_TYPES = [
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
] as const satisfies readonly TableFieldType[];

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
  /** IANA zone for datetimes written without an offset (the importer's own). Default UTC. */
  timezone?: string;
}

export interface TableImportResult {
  created: number;
  /** The first 100 failed rows; `row` is the line in the file, counting the header. */
  failed: Array<{ row: number; errors: string[] }>;
  createdFieldIds: number[];
  /** Every failed row (`failed` lists the first 100). */
  failedCount?: number;
}

/**
 * commitImport's answer. Each call writes for a few seconds; while `status`
 * is `committing`, call again with the same input to continue (a resumed
 * commit keeps the plan it started with).
 */
export interface TableImportProgress {
  importId: string;
  status: 'committing' | 'committed' | 'failed';
  totalRows: number;
  processedRows: number;
  result: TableImportResult;
  /** status = failed: why the import stopped. */
  error?: string;
}

/** previewImport with a mapping: the same checks as the commit over every row, nothing written. */
export interface TableImportValidation {
  totalRows: number;
  validRows: number;
  /** The first 100 rows that would fail. */
  failed: Array<{ row: number; errors: string[] }>;
  failedCount: number;
  /** Mapped required fields left empty, and required fields left unmapped (names). */
  missingRequired: string[];
}

// ─── Conversational schema editing ───────────────────────
//
// The `tables_schema_plan` tool drafts these; it writes nothing. They are
// applied only by POST /api/tables/schema-plan/apply, which the user reaches
// by pressing Confirm on the plan card — the model has no route to it.

/**
 * A plan-local identifier for an object this same plan creates, so a plan can
 * say "add these fields to the table I'm about to create". Never a database id.
 * Letters, digits, `_` and `-` (≤ 64); one namespace per plan.
 */
export type SchemaPlanRef = string;

/**
 * Kinds of plan-created object a config may point at with a `"$<kind>:<ref>"`
 * token — anywhere in an op's config JSON, as a value OR an object key (D18):
 * `{"kanban": {"groupFieldId": "$field:status"}}`, `{"widths": {"$field:status": 160}}`.
 * In text, `{{field:$field:<ref>}}` (automation templates) is rewritten too.
 */
export const SCHEMA_PLAN_REF_KINDS = ['field', 'table', 'view', 'form', 'automation', 'dashboard', 'role'] as const;
export type SchemaPlanRefKind = (typeof SCHEMA_PLAN_REF_KINDS)[number];

/** Everything a plan can create (a Base, a widget and an app can be named by ref, but not by `$` token). */
export type SchemaPlanObjectKind = SchemaPlanRefKind | 'base' | 'widget' | 'app';

/** An op's config: plain JSON that may hold `$<kind>:<ref>` tokens; the real handler validates it. */
export type SchemaPlanConfig = Record<string, unknown>;

/** A field config in a plan: ids may be `$field:` / `$table:` tokens. Formulas take the AST. */
export interface SchemaPlanFieldConfig {
  options?: Array<{ id: string; label: string; color?: string }>;
  relation?: { targetTableId: number | string; multiple?: boolean };
  formula?: { resultType: TableFormulaResultType; expression: unknown };
  rollup?: { relationFieldId: number | string; targetFieldId: number | string; aggregation: TableRollupAggregation };
  lookup?: { relationFieldId: number | string; targetFieldId: number | string };
}

export type SchemaPlanFormAudience =
  | { type: 'base' }
  | { type: 'team' }
  | { type: 'principals'; userIds?: string[]; groupIds?: number[] };

/** `none` removes the grant. Groups never get `builder` (D12). `custom` names a role of the same Base. */
export type SchemaPlanMemberRole = 'builder' | 'editor' | 'viewer' | 'custom' | 'none';

/**
 * Who an app is shared with, in a plan — the same shape as `AppAudienceEntry`
 * (`@greenhouse/types/apps`): a person, a group or everyone, each with one of
 * the app's role keys. Ids come from `tables_query directory.search`.
 */
export interface SchemaPlanAppAudienceEntry {
  principal: { type: 'user'; userId: string } | { type: 'group'; groupId: number } | { type: 'team' };
  roleKey: string;
}

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
      /**
       * Every new table starts with a required primary text field "Name". A ref
       * lets later operations point at it (a form or an app card usually needs
       * it); a name renames it (`申请事项`, `Title`). Additive, 2026-10 (apps).
       */
      primaryFieldRef?: SchemaPlanRef;
      primaryFieldName?: string;
    }
  | {
      op: 'base.update';
      /** Exactly one of baseId / baseRef. */
      baseId?: number;
      baseRef?: SchemaPlanRef;
      name?: string;
      description?: string | null;
      visibility?: TableBaseVisibility;
      /** What every internal user gets when the Base is visible to the team. */
      teamRole?: 'viewer' | 'editor' | 'custom';
      /** teamRole=custom: exactly one of roleRef / teamCustomRoleId. */
      roleRef?: SchemaPlanRef;
      teamCustomRoleId?: number;
    }
  | {
      op: 'table.create';
      ref?: SchemaPlanRef;
      /** Exactly one of baseRef / baseId. */
      baseRef?: SchemaPlanRef;
      baseId?: number;
      name: string;
      description?: string;
      /** The new table's primary "Name" field: a ref to point at it, a name to rename it (as on base.create). */
      primaryFieldRef?: SchemaPlanRef;
      primaryFieldName?: string;
    }
  | { op: 'table.update'; tableId: number; name?: string; description?: string | null }
  | {
      op: 'field.create';
      ref?: SchemaPlanRef;
      /** Exactly one of tableRef / tableId. */
      tableRef?: SchemaPlanRef;
      tableId?: number;
      name: string;
      type: TableFieldType;
      required?: boolean;
      config?: SchemaPlanFieldConfig;
    }
  | {
      op: 'field.update';
      /** Carried for the draft-time permission probe and to prove the field really is in this table. */
      tableId: number;
      fieldId: number;
      name?: string;
      required?: boolean;
      config?: SchemaPlanFieldConfig;
    }
  | { op: 'field.archive'; tableId: number; fieldId: number }
  | {
      op: 'view.create';
      ref?: SchemaPlanRef;
      tableRef?: SchemaPlanRef;
      tableId?: number;
      name: string;
      type?: TableViewType;
      /** Default shared (builder); personal = only its author sees it. */
      scope?: TableViewScope;
      config?: SchemaPlanConfig;
    }
  | {
      op: 'view.update';
      tableId: number;
      viewId: number;
      revision: number;
      name?: string;
      type?: TableViewType;
      config?: SchemaPlanConfig;
    }
  | {
      op: 'form.create';
      ref?: SchemaPlanRef;
      tableRef?: SchemaPlanRef;
      tableId?: number;
      name: string;
      status?: 'draft' | 'published';
      audience?: SchemaPlanFormAudience;
      config: SchemaPlanConfig;
    }
  | {
      op: 'form.update';
      formId: number;
      revision: number;
      name?: string;
      status?: 'draft' | 'published';
      audience?: SchemaPlanFormAudience;
      config?: SchemaPlanConfig;
    }
  | {
      op: 'automation.create';
      ref?: SchemaPlanRef;
      tableRef?: SchemaPlanRef;
      tableId?: number;
      name: string;
      trigger: TableAutomationTrigger;
      status?: 'disabled' | 'enabled';
      /** No webhook actions (UI only, D16); the executor is whoever confirms (D17). */
      config: SchemaPlanConfig;
    }
  | {
      op: 'automation.update';
      tableId: number;
      automationId: number;
      revision: number;
      name?: string;
      trigger?: TableAutomationTrigger;
      status?: 'disabled' | 'enabled';
      config?: SchemaPlanConfig;
    }
  | {
      op: 'dashboard.create';
      ref?: SchemaPlanRef;
      baseRef?: SchemaPlanRef;
      baseId?: number;
      name: string;
      description?: string;
      config?: SchemaPlanConfig;
    }
  | {
      op: 'dashboard.update';
      dashboardId: number;
      revision: number;
      name?: string;
      description?: string | null;
      config?: SchemaPlanConfig;
    }
  | {
      op: 'widget.create';
      ref?: SchemaPlanRef;
      dashboardRef?: SchemaPlanRef;
      dashboardId?: number;
      title: string;
      /** A `TableCardSpec`. */
      card: SchemaPlanConfig;
      layout?: { x: number; y: number; w: number; h: number };
    }
  | {
      op: 'widget.update';
      dashboardId: number;
      widgetId: number;
      revision: number;
      title?: string;
      card?: SchemaPlanConfig;
      layout?: { x: number; y: number; w: number; h: number };
    }
  | { op: 'widget.delete'; dashboardId: number; widgetId: number }
  | {
      op: 'role.create';
      ref?: SchemaPlanRef;
      baseRef?: SchemaPlanRef;
      baseId?: number;
      name: string;
      description?: string;
      /** `TableAccessRules`. */
      rules: SchemaPlanConfig;
    }
  | {
      op: 'role.update';
      baseId: number;
      roleId: number;
      revision: number;
      name?: string;
      description?: string | null;
      rules?: SchemaPlanConfig;
    }
  | {
      op: 'member.set';
      baseRef?: SchemaPlanRef;
      baseId?: number;
      principal: 'user' | 'group';
      /** principal=user. */
      userId?: string;
      /** principal=group. */
      groupId?: number;
      role: SchemaPlanMemberRole;
      /** role=custom: exactly one of roleRef / customRoleId. */
      roleRef?: SchemaPlanRef;
      customRoleId?: number;
    }
  /*
   * Apps (spec 20261011-tables-apps §7). `spec` is an `AppSpec` whose ids may be
   * `$field:` / `$table:` / `$automation:` … tokens, as keys or values; it is
   * checked against the virtual schema when the plan is drafted. Publishing and
   * changing who an app is shared with are the Base owner's (D2).
   */
  | {
      op: 'app.create';
      ref?: SchemaPlanRef;
      /** Exactly one of baseRef / baseId. */
      baseRef?: SchemaPlanRef;
      baseId?: number;
      name: string;
      description?: string;
      /** One of `APP_ICONS`. */
      icon?: string;
      /** One of `APP_ACCENTS`. */
      accent?: string;
      spec: SchemaPlanConfig;
    }
  | {
      op: 'app.update';
      /** Exactly one of appId / appRef. */
      appId?: number;
      appRef?: SchemaPlanRef;
      /** The draft revision you read (apps.get); without it the draft is replaced whatever it holds now. */
      draftRevision?: number;
      name?: string;
      /** Replaces the whole draft. */
      spec?: SchemaPlanConfig;
    }
  | {
      op: 'app.audience';
      appId?: number;
      appRef?: SchemaPlanRef;
      /** Replaces who the app is shared with. */
      entries: SchemaPlanAppAudienceEntry[];
      audiencesRevision?: number;
    }
  | {
      op: 'app.publish';
      appId?: number;
      appRef?: SchemaPlanRef;
      notes: string;
      /** Required for an existing app unless this plan wrote its draft (app.update) earlier. */
      draftRevision?: number;
    };

export type SchemaPlanOperationKind = SchemaPlanOperation['op'];

/** One side of an access change, as the card words it. */
export type SchemaPlanAccessLevel =
  | { kind: 'none' }
  | { kind: 'role'; role: 'owner' | 'builder' | 'editor' | 'viewer' }
  | { kind: 'custom'; roleName: string };

export type SchemaPlanAudienceView = { kind: 'base' } | { kind: 'team' } | { kind: 'principals'; names: string[] };

/** What one custom role can do, table by table (counts only — never row predicates). */
export interface SchemaPlanRuleSummary {
  tables: Array<{ table: string; access: 'read' | 'edit'; limitedRows: boolean; hiddenFields: number }>;
  dashboards: boolean;
}

/**
 * A permission change the plan makes, derived by the server at draft time
 * from the current grants — shown in its own section before Confirm.
 */
export type SchemaPlanAccessChange =
  | {
      index: number;
      kind: 'grant';
      base: string;
      principal: 'user' | 'group';
      name: string;
      before: SchemaPlanAccessLevel;
      after: SchemaPlanAccessLevel;
    }
  | {
      index: number;
      kind: 'team';
      base: string;
      /** `none` = the Base is not visible to the team. */
      before: SchemaPlanAccessLevel;
      after: SchemaPlanAccessLevel;
    }
  | { index: number; kind: 'role'; role: string; before: SchemaPlanRuleSummary | null; after: SchemaPlanRuleSummary }
  | {
      index: number;
      kind: 'form';
      form: string;
      before: SchemaPlanAudienceView | null;
      after: SchemaPlanAudienceView;
      published: boolean;
    }
  /** `app.audience`: who the app is shared with, before (null = nobody yet) → after. */
  | {
      index: number;
      kind: 'app_audience';
      app: string;
      before: SchemaPlanAppAudienceView[] | null;
      after: SchemaPlanAppAudienceView[];
    }
  /** `app.publish`: version `version` goes live for everyone the app is shared with at that point. */
  | { index: number; kind: 'app_publish'; app: string; version: number; audience: SchemaPlanAppAudienceView[] };

/** One app audience entry as the card words it: who, through which app role. */
export interface SchemaPlanAppAudienceView {
  principal: 'user' | 'group' | 'team';
  /** Person or group name (empty for the team). */
  name: string;
  /** The app role's display name. */
  role: string;
  /** Groups: who controls the membership — sharing with a group delegates "who gets in" to them. */
  managedBy?: string;
}

/** Tool output rendered by the web plan card. Contains no ids of its own — the plan was never persisted. */
export interface TablesSchemaPlanArtifact {
  type: 'tables_schema_plan';
  /** One line in the user's language, shown under the card title. */
  summary: string;
  operations: SchemaPlanOperation[];
  /** Server-derived; empty when the plan changes nobody's access. */
  accessChanges?: SchemaPlanAccessChange[];
  /**
   * Server-derived: operation index → the current name of the existing object
   * it changes (a field to archive, a widget to delete, the person a grant is
   * for), so the confirm gate never shows only `#17` or a user id.
   */
  targetNames?: Record<number, string>;
}

export type SchemaPlanResultStatus = 'applied' | 'failed' | 'skipped';

export interface SchemaPlanOperationResult {
  /** Index into the submitted operations array. */
  index: number;
  op: SchemaPlanOperationKind;
  status: SchemaPlanResultStatus;
  /** Id of the created or touched object, when one exists. */
  id?: number;
  /** Failure reason, or which ref's failure caused this one to be skipped — or a note on an applied one. */
  message?: string;
  /**
   * The app draft revision this operation wrote (`app.create`, `app.update` with a spec — even one that then
   * failed on its rename): a retry builds on it and publishes exactly that draft (additive).
   */
  draftRevision?: number;
}

/** The ref → id map an apply built: what a retry reuses instead of creating again. */
export type SchemaPlanRefMap = Record<SchemaPlanRef, { kind: SchemaPlanObjectKind; id: number }>;

/** The apply route's answer, and the receipt it stores. */
export interface SchemaPlanApplyResult {
  results: SchemaPlanOperationResult[];
  /** The Base the plan touched, when it is unambiguous — lets the card link to it. */
  baseId?: number;
  /** Refs resolved so far (absent on receipts written before retries existed). */
  refs?: SchemaPlanRefMap;
  /** How many times the plan ran: 1, plus one per "retry unfinished operations". */
  attempts?: number;
}
