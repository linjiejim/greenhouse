/**
 * Tables application shared wire contracts.
 *
 * These are deliberately transport-neutral. Database rows stay inferred in
 * @greenhouse/db; REST, Web, Agent Proxy, and MCP share only the dynamic-field
 * values and bounded query/aggregate contracts defined here.
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
] as const;

export type TableFieldType = (typeof TABLE_FIELD_TYPES)[number];

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

export const TABLE_FORMULA_FUNCTIONS = ['if', 'coalesce', 'concat', 'round', 'upper', 'lower'] as const;
export type TableFormulaFunction = (typeof TABLE_FORMULA_FUNCTIONS)[number];

export type TableFormulaExpression =
  | { type: 'literal'; value: string | number | boolean | null }
  | { type: 'field'; fieldId: string }
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
    targetTableId: string;
    multiple?: boolean;
  };
  formula?: {
    resultType: TableFormulaResultType;
    expression: TableFormulaExpression;
  };
  rollup?: {
    relationFieldId: string;
    targetFieldId: string;
    aggregation: TableRollupAggregation;
  };
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

export interface TableFilterClause {
  fieldId: string;
  operator: TableFilterOperator;
  value?: unknown;
}

export interface TableFilterGroup {
  combinator: 'and' | 'or';
  clauses: TableFilterClause[];
}

export interface TableSort {
  fieldId?: string;
  systemField?: 'created_at' | 'updated_at';
  direction: 'asc' | 'desc';
}

export interface TableQuery {
  where?: TableFilterGroup;
  /** Only these records (by id, at most 500) — e.g. the labels of linked records in one call. */
  recordIds?: string[];
  search?: string;
  sort?: TableSort[];
  /** Opaque cursor returned by a previous query with the same filters/sort. */
  cursor?: string;
  limit?: number;
}

export type TableBaseRole = 'owner' | 'builder' | 'editor' | 'viewer';
export type TableBaseVisibility = 'private' | 'team';
export type TableViewScope = 'shared' | 'personal';

export interface TableViewConfig {
  version?: number;
  fieldIds?: string[];
  widths?: Record<string, number>;
  /**
   * How many leading columns stay pinned to the left while scrolling.
   * A contiguous prefix rather than an arbitrary set of columns: anything else
   * fights with column order and the cumulative offsets used to place them.
   */
  frozenCount?: number;
  query?: Omit<TableQuery, 'cursor' | 'limit'>;
}

export const TABLE_AGGREGATIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type TableAggregation = (typeof TABLE_AGGREGATIONS)[number];

export const TABLE_SCHEMA_CHANGE_TYPES = ['created', 'field_created', 'field_updated', 'field_archived'] as const;
export type TableSchemaChangeType = (typeof TABLE_SCHEMA_CHANGE_TYPES)[number];

export interface TableSchemaSnapshotField {
  id: string;
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
  tableId: string;
  fields: TableSchemaSnapshotField[];
}

export interface TableBatchValidationResult {
  index: number;
  ok: boolean;
  reason?: 'not_found' | 'conflict' | 'invalid';
  message?: string;
  current?: number;
}

export interface TableAggregateInput {
  operation: TableAggregation;
  valueFieldId?: string;
  groupByFieldId?: string;
  query?: Omit<TableQuery, 'cursor' | 'limit'>;
  limit?: number;
}

export interface TableAggregateRow {
  group: string | number | boolean | null;
  value: number;
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
      baseId: string;
      name?: string;
      description?: string | null;
      visibility?: TableBaseVisibility;
    }
  | {
      op: 'table.create';
      ref?: SchemaPlanRef;
      /** Exactly one of baseRef / baseId. */
      baseRef?: SchemaPlanRef;
      baseId?: string;
      name: string;
      description?: string;
    }
  | { op: 'table.update'; tableId: string; name?: string; description?: string | null }
  | {
      op: 'field.create';
      /** Exactly one of tableRef / tableId. */
      tableRef?: SchemaPlanRef;
      tableId?: string;
      name: string;
      type: TableFieldType;
      required?: boolean;
      config?: TableFieldConfig;
    }
  | {
      op: 'field.update';
      /** Carried for the draft-time permission probe and to prove the field really is in this table. */
      tableId: string;
      fieldId: string;
      name?: string;
      required?: boolean;
      config?: TableFieldConfig;
    }
  | { op: 'field.archive'; tableId: string; fieldId: string };

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
  id?: string;
  /** Failure reason, or which ref's failure caused this one to be skipped. */
  message?: string;
}

export interface SchemaPlanApplyResult {
  results: SchemaPlanOperationResult[];
  /** The Base the plan touched, when it is unambiguous — lets the card link to it. */
  baseId?: string;
}
