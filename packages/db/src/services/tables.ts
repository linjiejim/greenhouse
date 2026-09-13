/**
 * Tables domain service — fixed-schema metadata, validated dynamic records,
 * bounded query AST, optimistic concurrency, and dashboard aggregation.
 */

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { safeJsonParse } from '@greenhouse/utils/json';
import { resolveCapability } from '@greenhouse/platform-kernel';
import {
  TABLE_AGGREGATIONS,
  TABLE_DASHBOARD_WIDGET_TYPES,
  TABLE_FIELD_TYPES,
  TABLE_FILTER_OPERATORS,
  TABLE_FORMULA_BINARY_OPERATORS,
  TABLE_FORMULA_FUNCTIONS,
} from '@greenhouse/types/tables';
import type {
  TableAggregateInput,
  TableAggregateRow,
  TableAutomationAction,
  TableAutomationConfig,
  TableAutomationTrigger,
  TableBaseRole,
  TableBaseVisibility,
  TableBatchValidationResult,
  TableDashboardWidgetConfig,
  TableDashboardWidgetLayout,
  TableDashboardWidgetType,
  TableFieldConfig,
  TableFieldType,
  TableFilterClause,
  TableFilterGroup,
  TableFormConfig,
  TableFormulaExpression,
  TableQuery,
  TableRecordValues,
  TableSchemaChangeType,
  TableSchemaSnapshot,
  TableViewConfig,
  TableViewScope,
} from '@greenhouse/types/tables';
import type { Db } from '../client.js';
import {
  tableBaseMembers,
  tableBases,
  tableAutomationOutbox,
  tableAutomationRules,
  tableAutomationRuns,
  tableDashboardWidgets,
  tableDashboards,
  tableFieldDependencies,
  tableFields,
  tableForms,
  tableNotifications,
  tableRecordAttachments,
  tableRecordLinks,
  tableRecords,
  tableRecomputeJobs,
  tableSchemaVersions,
  tableTables,
  tableViews,
  driveFiles,
  users,
} from '../schema/index.js';
import type {
  TableBaseMemberRow,
  TableBaseRow,
  TableAutomationRuleRow,
  TableAutomationRunRow,
  TableDashboardRow,
  TableDashboardWidgetRow,
  TableDefinitionRow,
  TableFieldDependencyRow,
  TableFieldRow,
  TableFormRow,
  TableNotificationRow,
  TableRecomputeJobRow,
  TableRecordAttachmentRow,
  TableRecordLinkRow,
  TableRecordRow,
  TableSchemaVersionRow,
  TableViewRow,
} from '../schema/tables.js';
import { createPlatformService } from './platform.js';

type TablesTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

const MAX_FIELDS = 100;
const MAX_QUERY_CLAUSES = 20;
const MAX_QUERY_SORTS = 3;
const MAX_QUERY_LIMIT = 500;
const MAX_BATCH_RECORDS = 100;

export class TablesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TablesValidationError';
  }
}

export interface CreateTableBaseInput {
  name: string;
  description?: string | null;
  visibility?: TableBaseVisibility;
  owner_id: string;
  created_by: string;
}

export interface UpdateTableBaseInput {
  name?: string;
  description?: string | null;
  visibility?: TableBaseVisibility;
}

export interface CreateTableDefinitionInput {
  base_id: number;
  name: string;
  description?: string | null;
  created_by: string;
}

export interface CreateTableFieldInput {
  table_id: number;
  name: string;
  type: TableFieldType;
  required?: boolean;
  config?: TableFieldConfig;
  position?: number;
  created_by: string;
}

export interface UpdateTableFieldInput {
  updated_by: string;
  name?: string;
  required?: boolean;
  config?: TableFieldConfig;
  position?: number;
}

export interface UpdateTableViewInput {
  revision: number;
  name?: string;
  config?: TableViewConfig;
  position?: number;
}

export interface CreateTableViewInput {
  table_id: number;
  name: string;
  scope?: TableViewScope;
  owner_id?: string | null;
  config?: TableViewConfig;
  position?: number;
  created_by: string;
}

export interface CreateTableFormInput {
  table_id: number;
  name: string;
  status?: 'draft' | 'published';
  config: TableFormConfig;
  user_id: string;
}

export interface UpdateTableFormInput {
  revision: number;
  name?: string;
  status?: 'draft' | 'published';
  config?: TableFormConfig;
  user_id: string;
}

export interface CreateTableAutomationInput {
  base_id: number;
  table_id: number;
  name: string;
  status?: 'disabled' | 'enabled';
  trigger: TableAutomationTrigger;
  config: TableAutomationConfig;
  execution_user_id: string;
  user_id: string;
}

export interface UpdateTableAutomationInput {
  revision: number;
  name?: string;
  status?: 'disabled' | 'enabled';
  trigger?: TableAutomationTrigger;
  config?: TableAutomationConfig;
  execution_user_id?: string;
  user_id: string;
}

export interface CreateTableRecordInput {
  table_id: number;
  values: TableRecordValues;
  user_id: string;
}

export interface UpdateTableRecordInput {
  table_id: number;
  record_id: number;
  revision: number;
  values: TableRecordValues;
  user_id: string;
}

export interface BatchUpsertTableRecordItem {
  record_id?: number;
  revision?: number;
  values: TableRecordValues;
}

export interface CreateTableDashboardInput {
  base_id: number;
  name: string;
  description?: string | null;
  created_by: string;
}

export interface CreateTableDashboardWidgetInput {
  dashboard_id: number;
  table_id?: number | null;
  type: TableDashboardWidgetType;
  title: string;
  config?: TableDashboardWidgetConfig;
  layout?: TableDashboardWidgetLayout;
  position?: number;
  created_by: string;
}

export interface UpdateTableDashboardInput {
  revision: number;
  name?: string;
  description?: string | null;
}

export interface UpdateTableDashboardWidgetInput {
  revision: number;
  table_id?: number | null;
  title?: string;
  config?: TableDashboardWidgetConfig;
  layout?: TableDashboardWidgetLayout;
  position?: number;
}

export type TableRevisionResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' | 'conflict'; current?: number };

export interface TableRecordQueryResult {
  records: TableRecordRow[];
  total: number;
  nextCursor: string | null;
}

export interface TableSchemaResult {
  table: TableDefinitionRow;
  fields: TableFieldRow[];
  views: TableViewRow[];
}

export interface TableDashboardResult {
  dashboard: TableDashboardRow;
  widgets: TableDashboardWidgetRow[];
}

function trimmed(value: string, field: string, max: number): string {
  const result = value.trim();
  if (!result) throw new TablesValidationError(`${field} is required`);
  if (result.length > max) throw new TablesValidationError(`${field} exceeds ${max} characters`);
  return result;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateFieldType(type: TableFieldType): void {
  if (!TABLE_FIELD_TYPES.includes(type)) throw new TablesValidationError(`Unsupported field type "${type}"`);
}

function validateWidgetType(type: TableDashboardWidgetType): void {
  if (!TABLE_DASHBOARD_WIDGET_TYPES.includes(type)) {
    throw new TablesValidationError(`Unsupported dashboard widget type "${type}"`);
  }
}

function validateQueryShape(query: TableQuery): void {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new TablesValidationError('query must be an object');
  }
  if (query.search !== undefined && typeof query.search !== 'string') {
    throw new TablesValidationError('search must be text');
  }
  if (query.cursor !== undefined && typeof query.cursor !== 'string') {
    throw new TablesValidationError('cursor must be text');
  }
  if (query.where !== undefined) {
    if (
      !query.where ||
      typeof query.where !== 'object' ||
      !Array.isArray(query.where.clauses) ||
      (query.where.combinator !== 'and' && query.where.combinator !== 'or')
    ) {
      throw new TablesValidationError('where must contain an and/or combinator and clauses array');
    }
    for (const clause of query.where.clauses) {
      if (
        !clause ||
        typeof clause !== 'object' ||
        !isPositiveInteger(clause.fieldId) ||
        !TABLE_FILTER_OPERATORS.includes(clause.operator)
      ) {
        throw new TablesValidationError('Each filter clause requires a valid fieldId and operator');
      }
    }
  }
  if (query.sort !== undefined) {
    if (!Array.isArray(query.sort)) throw new TablesValidationError('sort must be an array');
    for (const sort of query.sort) {
      if (
        !sort ||
        typeof sort !== 'object' ||
        (sort.direction !== 'asc' && sort.direction !== 'desc') ||
        (sort.fieldId !== undefined && !isPositiveInteger(sort.fieldId)) ||
        (sort.systemField !== undefined && sort.systemField !== 'created_at' && sort.systemField !== 'updated_at') ||
        (sort.fieldId === undefined && sort.systemField === undefined) ||
        (sort.fieldId !== undefined && sort.systemField !== undefined)
      ) {
        throw new TablesValidationError('Each sort requires one valid field and asc/desc direction');
      }
    }
  }
}

function normalizeWidgetConfig(
  type: TableDashboardWidgetType,
  input: TableDashboardWidgetConfig = {},
): TableDashboardWidgetConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TablesValidationError('Widget config must be an object');
  }
  if (type === 'text') {
    if (input.text !== undefined && typeof input.text !== 'string') {
      throw new TablesValidationError('Text widget content must be text');
    }
    if ((input.text?.length ?? 0) > 100_000) throw new TablesValidationError('Text widget exceeds 100,000 characters');
    return { version: 1, text: input.text ?? '' };
  }
  const operation = input.operation ?? 'count';
  if (!TABLE_AGGREGATIONS.includes(operation)) {
    throw new TablesValidationError(`Unsupported aggregation "${operation}"`);
  }
  if (input.valueFieldId !== undefined && !isPositiveInteger(input.valueFieldId)) {
    throw new TablesValidationError('valueFieldId must be a positive integer');
  }
  if (input.groupByFieldId !== undefined && !isPositiveInteger(input.groupByFieldId)) {
    throw new TablesValidationError('groupByFieldId must be a positive integer');
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
    throw new TablesValidationError('Widget limit must be between 1 and 100');
  }
  if (input.query !== undefined) validateQueryShape(input.query);
  return {
    version: 1,
    operation,
    ...(input.valueFieldId ? { valueFieldId: input.valueFieldId } : {}),
    ...(input.groupByFieldId ? { groupByFieldId: input.groupByFieldId } : {}),
    ...(input.query ? { query: input.query } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  };
}

function normalizeWidgetLayout(input?: TableDashboardWidgetLayout): TableDashboardWidgetLayout {
  const layout = input ?? { version: 1, x: 0, y: 0, w: 6, h: 4 };
  if (
    !layout ||
    typeof layout !== 'object' ||
    ![layout.x, layout.y, layout.w, layout.h].every((value) => Number.isInteger(value)) ||
    layout.x < 0 ||
    layout.y < 0 ||
    layout.w < 1 ||
    layout.h < 1 ||
    layout.w > 24 ||
    layout.h > 24
  ) {
    throw new TablesValidationError('Widget layout requires integer x/y >= 0 and w/h between 1 and 24');
  }
  return { ...layout, version: 1 };
}

function parseDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function uniqueStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  if (strings.length !== value.length) return undefined;
  return [...new Set(strings)];
}

function optionIds(config: TableFieldConfig): Set<string> {
  return new Set((config.options ?? []).map((option) => option.id));
}

export function parseTableFieldConfig(field: Pick<TableFieldRow, 'config'>): TableFieldConfig {
  const parsed = safeJsonParse(field.config, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TableFieldConfig) : {};
}

function buildSchemaSnapshot(tableId: number, fields: TableFieldRow[]): TableSchemaSnapshot {
  return {
    version: 1,
    tableId,
    fields: fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      required: field.required,
      isPrimary: field.is_primary,
      config: parseTableFieldConfig(field),
      position: field.position,
      archivedAt: field.archived_at,
    })),
  };
}

function normalizeFormulaExpression(
  expression: TableFormulaExpression,
  depth = 0,
  nodes = { count: 0 },
): TableFormulaExpression {
  nodes.count += 1;
  if (depth > 12 || nodes.count > 100) throw new TablesValidationError('Formula is too complex');
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) {
    throw new TablesValidationError('Formula expression is invalid');
  }
  if (expression.type === 'literal') {
    if (
      expression.value !== null &&
      typeof expression.value !== 'string' &&
      typeof expression.value !== 'number' &&
      typeof expression.value !== 'boolean'
    ) {
      throw new TablesValidationError('Formula literal is invalid');
    }
    return { type: 'literal', value: expression.value };
  }
  if (expression.type === 'field') {
    if (!isPositiveInteger(expression.fieldId)) throw new TablesValidationError('Formula fieldId is invalid');
    return { type: 'field', fieldId: expression.fieldId };
  }
  if (expression.type === 'binary') {
    if (!TABLE_FORMULA_BINARY_OPERATORS.includes(expression.operator)) {
      throw new TablesValidationError(`Unsupported formula operator "${expression.operator}"`);
    }
    return {
      type: 'binary',
      operator: expression.operator,
      left: normalizeFormulaExpression(expression.left, depth + 1, nodes),
      right: normalizeFormulaExpression(expression.right, depth + 1, nodes),
    };
  }
  if (expression.type === 'function') {
    if (!TABLE_FORMULA_FUNCTIONS.includes(expression.name)) {
      throw new TablesValidationError(`Unsupported formula function "${expression.name}"`);
    }
    if (!Array.isArray(expression.args) || expression.args.length > 10) {
      throw new TablesValidationError('Formula function supports at most 10 arguments');
    }
    return {
      type: 'function',
      name: expression.name,
      args: expression.args.map((argument) => normalizeFormulaExpression(argument, depth + 1, nodes)),
    };
  }
  throw new TablesValidationError('Formula expression type is invalid');
}

function formulaFieldIds(expression: TableFormulaExpression, result = new Set<number>()): Set<number> {
  if (expression.type === 'field') result.add(expression.fieldId);
  else if (expression.type === 'binary') {
    formulaFieldIds(expression.left, result);
    formulaFieldIds(expression.right, result);
  } else if (expression.type === 'function') {
    expression.args.forEach((argument) => formulaFieldIds(argument, result));
  }
  return result;
}

export function validateTableFieldConfig(type: TableFieldType, config: TableFieldConfig): TableFieldConfig {
  validateFieldType(type);
  if (type === 'relation') {
    if (!isPositiveInteger(config.relation?.targetTableId)) {
      throw new TablesValidationError('Relation fields require targetTableId');
    }
    return {
      version: 1,
      relation: {
        targetTableId: config.relation.targetTableId,
        multiple: config.relation.multiple === true,
      },
    };
  }
  if (type === 'formula') {
    if (!config.formula || !['text', 'number', 'boolean', 'date', 'datetime'].includes(config.formula.resultType)) {
      throw new TablesValidationError('Formula fields require a valid resultType');
    }
    return {
      version: 1,
      formula: {
        resultType: config.formula.resultType,
        expression: normalizeFormulaExpression(config.formula.expression),
      },
    };
  }
  if (type === 'rollup') {
    const rollup = config.rollup;
    if (
      !rollup ||
      !isPositiveInteger(rollup.relationFieldId) ||
      !isPositiveInteger(rollup.targetFieldId) ||
      !['count', 'sum', 'avg', 'min', 'max', 'join'].includes(rollup.aggregation)
    ) {
      throw new TablesValidationError('Rollup fields require relationFieldId, targetFieldId, and aggregation');
    }
    return { version: 1, rollup: { ...rollup } };
  }
  if (type !== 'single_select' && type !== 'multi_select') return { version: 1 };
  const options = config.options ?? [];
  if (!Array.isArray(options) || options.length > 100) {
    throw new TablesValidationError('Select fields support at most 100 options');
  }
  const ids = new Set<string>();
  const normalized = options.map((option, index) => {
    if (!option || typeof option !== 'object') {
      throw new TablesValidationError(`Option ${index + 1} is invalid`);
    }
    const id = trimmed(option.id, `Option ${index + 1} id`, 64);
    const label = trimmed(option.label, `Option ${index + 1} label`, 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new TablesValidationError(`Option id "${id}" must contain only letters, numbers, _ or -`);
    }
    if (ids.has(id)) throw new TablesValidationError(`Duplicate option id "${id}"`);
    ids.add(id);
    return { id, label, ...(option.color ? { color: option.color.slice(0, 32) } : {}) };
  });
  return { version: 1, options: normalized };
}

/**
 * Pure value validator used by write and query paths. User fields are checked
 * against the caller-provided active internal ID set.
 */
export function validateTableFieldValue(
  field: Pick<TableFieldRow, 'id' | 'name' | 'type' | 'config'>,
  value: unknown,
  activeUserIds: ReadonlySet<string>,
): unknown {
  if (value === null) return null;
  const config = parseTableFieldConfig(field as Pick<TableFieldRow, 'config'>);
  const invalid = (expected: string): never => {
    throw new TablesValidationError(`Field "${field.name}" expects ${expected}`);
  };

  switch (field.type) {
    case 'text':
      return typeof value === 'string' && value.length <= 10_000 ? value : invalid('text up to 10,000 characters');
    case 'long_text':
      return typeof value === 'string' && value.length <= 100_000 ? value : invalid('text up to 100,000 characters');
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : invalid('a finite number');
    case 'boolean':
      return typeof value === 'boolean' ? value : invalid('a boolean');
    case 'date':
      return typeof value === 'string' && parseDate(value) ? value : invalid('a YYYY-MM-DD date');
    case 'datetime': {
      if (typeof value !== 'string') return invalid('an ISO 8601 datetime');
      const parsed = new Date(value);
      return Number.isNaN(parsed.valueOf()) ? invalid('an ISO 8601 datetime') : parsed.toISOString();
    }
    case 'single_select':
      return typeof value === 'string' && optionIds(config).has(value) ? value : invalid('a configured option id');
    case 'multi_select': {
      const values = uniqueStrings(value);
      return values && values.every((entry) => optionIds(config).has(entry))
        ? values
        : invalid('configured option ids');
    }
    case 'user':
      return typeof value === 'string' && activeUserIds.has(value) ? value : invalid('an active internal user id');
    case 'multi_user': {
      const values = uniqueStrings(value);
      return values && values.every((entry) => activeUserIds.has(entry)) ? values : invalid('active internal user ids');
    }
    case 'url': {
      if (typeof value !== 'string' || value.length > 2_000) return invalid('an http/https URL');
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? value : invalid('an http/https URL');
      } catch {
        return invalid('an http/https URL');
      }
    }
    case 'email':
      return typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        ? value
        : invalid('an email address');
    case 'phone':
      return typeof value === 'string' && value.length <= 64 ? value : invalid('a phone string up to 64 characters');
    case 'attachment': {
      if (!Array.isArray(value) || value.length > 100) return invalid('Drive file ids');
      const values = [...new Set(value)];
      return values.every((entry) => typeof entry === 'number' && Number.isInteger(entry) && entry > 0)
        ? values
        : invalid('Drive file ids');
    }
    case 'relation': {
      const multiple = config.relation?.multiple === true;
      if (multiple) {
        return Array.isArray(value) &&
          value.length <= 500 &&
          value.every((entry) => typeof entry === 'number' && Number.isInteger(entry) && entry > 0)
          ? [...new Set(value as number[])]
          : invalid('record ids');
      }
      return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : invalid('a record id');
    }
    case 'formula':
    case 'rollup':
      return invalid('a computed value');
  }
}

function queryFingerprint(tableId: number, query: TableQuery): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        tableId,
        where: query.where ?? null,
        search: query.search ?? null,
        sort: query.sort ?? [],
      }),
    )
    .digest('base64url')
    .slice(0, 24);
}

function encodeCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ offset, fingerprint }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, fingerprint: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown;
      fingerprint?: unknown;
    };
    if (
      typeof parsed.offset !== 'number' ||
      !Number.isInteger(parsed.offset) ||
      parsed.offset < 0 ||
      parsed.fingerprint !== fingerprint
    ) {
      throw new Error('invalid');
    }
    return parsed.offset;
  } catch {
    throw new TablesValidationError('cursor is invalid for this query');
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function recordFieldJson(key: string): SQL {
  return sql`coalesce(${tableRecords.computed_values} -> ${key}, ${tableRecords.values} -> ${key})`;
}

function recordFieldText(key: string): SQL {
  return sql`coalesce(${tableRecords.computed_values} ->> ${key}, ${tableRecords.values} ->> ${key})`;
}

function equalityExpression(field: TableFieldRow, value: unknown): SQL {
  const key = String(field.id);
  return sql`${recordFieldJson(key)} = ${JSON.stringify(value)}::jsonb`;
}

function comparisonExpression(field: TableFieldRow, value: unknown, operator: 'gt' | 'gte' | 'lt' | 'lte'): SQL {
  const key = String(field.id);
  const left = field.type === 'number' ? sql`NULLIF(${recordFieldText(key)}, '')::numeric` : recordFieldText(key);
  if (operator === 'gt') return sql`${left} > ${value}`;
  if (operator === 'gte') return sql`${left} >= ${value}`;
  if (operator === 'lt') return sql`${left} < ${value}`;
  return sql`${left} <= ${value}`;
}

function allowedOperators(type: TableFieldType): ReadonlySet<TableFilterClause['operator']> {
  const common = ['eq', 'neq', 'is_empty', 'is_not_empty', 'in'] as const;
  if (type === 'number' || type === 'date' || type === 'datetime') {
    return new Set([...common, 'gt', 'gte', 'lt', 'lte']);
  }
  if (type === 'text' || type === 'long_text' || type === 'url' || type === 'email' || type === 'phone') {
    return new Set([...common, 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte']);
  }
  if (type === 'multi_select' || type === 'multi_user' || type === 'attachment') {
    return new Set([...common, 'contains', 'not_contains']);
  }
  return new Set(common);
}

function queryValueField(field: TableFieldRow): TableFieldRow {
  const config = parseTableFieldConfig(field);
  if (field.type === 'formula' && config.formula) return { ...field, type: config.formula.resultType };
  if (field.type === 'rollup' && config.rollup) {
    return { ...field, type: config.rollup.aggregation === 'join' ? 'text' : 'number' };
  }
  return field;
}

function clauseExpression(clause: TableFilterClause, field: TableFieldRow, activeUserIds: ReadonlySet<string>): SQL {
  const valueField = queryValueField(field);
  if (!allowedOperators(valueField.type).has(clause.operator)) {
    throw new TablesValidationError(`Operator ${clause.operator} is not supported for ${field.type}`);
  }
  const key = String(field.id);
  if (clause.operator === 'is_empty') {
    return sql`(${recordFieldJson(key)} IS NULL OR ${recordFieldJson(key)} = 'null'::jsonb OR ${recordFieldText(key)} = '')`;
  }
  if (clause.operator === 'is_not_empty') {
    return sql`NOT (${recordFieldJson(key)} IS NULL OR ${recordFieldJson(key)} = 'null'::jsonb OR ${recordFieldText(key)} = '')`;
  }
  if (clause.operator === 'contains' || clause.operator === 'not_contains') {
    let contains: SQL;
    if (field.type === 'multi_select' || field.type === 'multi_user' || field.type === 'attachment') {
      const item = validateTableFieldValue(
        {
          ...valueField,
          type:
            valueField.type === 'multi_select' ? 'single_select' : valueField.type === 'multi_user' ? 'user' : 'text',
        },
        clause.value,
        activeUserIds,
      );
      contains = sql`${recordFieldJson(key)} @> ${JSON.stringify([item])}::jsonb`;
    } else {
      if (typeof clause.value !== 'string') {
        throw new TablesValidationError(`Field "${field.name}" contains expects text`);
      }
      contains = sql`${recordFieldText(key)} ILIKE ${`%${escapeLike(clause.value)}%`} ESCAPE '\\'`;
    }
    return clause.operator === 'not_contains' ? sql`NOT (${contains})` : contains;
  }
  if (clause.operator === 'in') {
    if (!Array.isArray(clause.value) || clause.value.length < 1 || clause.value.length > 50) {
      throw new TablesValidationError('in expects an array with 1-50 values');
    }
    const expressions = clause.value.map((value) =>
      equalityExpression(field, validateTableFieldValue(valueField, value, activeUserIds)),
    );
    return or(...expressions)!;
  }
  const value = validateTableFieldValue(valueField, clause.value, activeUserIds);
  if (clause.operator === 'eq') return equalityExpression(field, value);
  if (clause.operator === 'neq') return sql`NOT (${equalityExpression(field, value)})`;
  return comparisonExpression(valueField, value, clause.operator);
}

interface TableValidationContext {
  fields: TableFieldRow[];
  byId: Map<string, TableFieldRow>;
  activeUserIds: Set<string>;
  relationTargets: Map<string, Set<number>>;
  attachmentFileIds: Set<number>;
}

function validateValuesWithContext(
  context: TableValidationContext,
  values: TableRecordValues,
  options: { requireAll: boolean },
): TableRecordValues {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new TablesValidationError('values must be an object keyed by field id');
  }
  const normalized: TableRecordValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (!/^\d+$/.test(key)) throw new TablesValidationError(`Invalid field id "${key}"`);
    const field = context.byId.get(key);
    if (!field) throw new TablesValidationError(`Field ${key} is unavailable`);
    if (field.type === 'formula' || field.type === 'rollup') {
      throw new TablesValidationError(`Field "${field.name}" is computed and cannot be written`);
    }
    const nextValue = validateTableFieldValue(field, value, context.activeUserIds);
    if (field.type === 'relation' && nextValue !== null) {
      const validIds = context.relationTargets.get(key) ?? new Set<number>();
      const ids = Array.isArray(nextValue) ? (nextValue as number[]) : [nextValue as number];
      if (ids.some((id) => !validIds.has(id))) {
        throw new TablesValidationError(`Field "${field.name}" references an unavailable record`);
      }
    }
    if (field.type === 'attachment' && Array.isArray(nextValue)) {
      const numericIds = nextValue.filter((entry): entry is number => typeof entry === 'number');
      if (numericIds.some((id) => !context.attachmentFileIds.has(id))) {
        throw new TablesValidationError(`Field "${field.name}" references an unavailable Base file`);
      }
    }
    normalized[key] = nextValue;
  }
  if (options.requireAll) {
    for (const field of context.fields) {
      if (field.type === 'formula' || field.type === 'rollup') continue;
      const value = normalized[String(field.id)];
      if (field.required && (value === undefined || value === null || value === '')) {
        throw new TablesValidationError(`Field "${field.name}" is required`);
      }
    }
  }
  return normalized;
}

function automationConditionMatches(
  condition: TableFilterGroup | undefined,
  fields: TableFieldRow[],
  values: TableRecordValues,
): boolean {
  if (!condition || condition.clauses.length === 0) return true;
  const byId = new Map(fields.map((field) => [field.id, field]));
  const matches = condition.clauses.map((clause) => {
    if (!byId.has(clause.fieldId)) return false;
    const value = values[String(clause.fieldId)];
    if (clause.operator === 'is_empty') {
      return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    }
    if (clause.operator === 'is_not_empty') {
      return !(value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0));
    }
    if (clause.operator === 'contains' || clause.operator === 'not_contains') {
      const contains = Array.isArray(value)
        ? value.includes(clause.value)
        : String(value ?? '')
            .toLocaleLowerCase()
            .includes(String(clause.value ?? '').toLocaleLowerCase());
      return clause.operator === 'contains' ? contains : !contains;
    }
    if (clause.operator === 'in') {
      return Array.isArray(clause.value) && clause.value.includes(value);
    }
    if (clause.operator === 'eq') return value === clause.value;
    if (clause.operator === 'neq') return value !== clause.value;
    const left = typeof value === 'number' ? value : String(value ?? '');
    const right = typeof clause.value === 'number' ? clause.value : String(clause.value ?? '');
    if (clause.operator === 'gt') return left > right;
    if (clause.operator === 'gte') return left >= right;
    if (clause.operator === 'lt') return left < right;
    return left <= right;
  });
  return condition.combinator === 'and' ? matches.every(Boolean) : matches.some(Boolean);
}

export function createTablesService(db: Db) {
  const platform = createPlatformService(db);
  const loadValidationContext = async (tableId: number): Promise<TableValidationContext> => {
    const fields = await db
      .select()
      .from(tableFields)
      .where(and(eq(tableFields.table_id, tableId), isNull(tableFields.archived_at)))
      .orderBy(asc(tableFields.position), asc(tableFields.id));
    const needsUsers = fields.some((field) => field.type === 'user' || field.type === 'multi_user');
    const needsAttachments = fields.some((field) => field.type === 'attachment');
    const activeUserIds = needsUsers
      ? new Set(
          (
            await db
              .select({ id: users.id })
              .from(users)
              .where(and(eq(users.status, 'active'), inArray(users.role, ['team', 'super'])))
          ).map((row) => row.id),
        )
      : new Set<string>();
    const relationFields = fields
      .filter((field) => field.type === 'relation')
      .map((field) => ({ field, config: parseTableFieldConfig(field) }))
      .filter(
        (
          entry,
        ): entry is { field: TableFieldRow; config: TableFieldConfig & { relation: { targetTableId: number } } } =>
          isPositiveInteger(entry.config.relation?.targetTableId),
      );
    const targetTableIds = [...new Set(relationFields.map((entry) => entry.config.relation.targetTableId))];
    const targetRows =
      targetTableIds.length === 0
        ? []
        : await db
            .select({ id: tableRecords.id, table_id: tableRecords.table_id })
            .from(tableRecords)
            .where(and(inArray(tableRecords.table_id, targetTableIds), isNull(tableRecords.deleted_at)));
    const idsByTable = new Map<number, Set<number>>();
    for (const record of targetRows) {
      const ids = idsByTable.get(record.table_id) ?? new Set<number>();
      ids.add(record.id);
      idsByTable.set(record.table_id, ids);
    }
    const [table] = needsAttachments
      ? await db.select({ base_id: tableTables.base_id }).from(tableTables).where(eq(tableTables.id, tableId)).limit(1)
      : [];
    const attachmentFileIds =
      needsAttachments && table
        ? new Set(
            (
              await db
                .select({ id: driveFiles.id })
                .from(driveFiles)
                .where(
                  and(
                    eq(driveFiles.scope, 'tables'),
                    eq(driveFiles.base_id, table.base_id),
                    eq(driveFiles.status, 'active'),
                  ),
                )
            ).map((file) => file.id),
          )
        : new Set<number>();
    return {
      fields,
      byId: new Map(fields.map((field) => [String(field.id), field])),
      activeUserIds,
      relationTargets: new Map(
        relationFields.map(({ field, config }) => [
          String(field.id),
          idsByTable.get(config.relation.targetTableId) ?? new Set<number>(),
        ]),
      ),
      attachmentFileIds,
    };
  };

  const normalizeFormConfig = async (tableId: number, input: TableFormConfig): Promise<TableFormConfig> => {
    if (!input || typeof input !== 'object' || !Array.isArray(input.fieldIds)) {
      throw new TablesValidationError('Form config requires fieldIds');
    }
    const fieldIds = [...new Set(input.fieldIds)];
    if (fieldIds.length < 1 || fieldIds.length > MAX_FIELDS || !fieldIds.every(isPositiveInteger)) {
      throw new TablesValidationError(`Form requires 1-${MAX_FIELDS} valid field ids`);
    }
    const fields = await db
      .select()
      .from(tableFields)
      .where(
        and(eq(tableFields.table_id, tableId), inArray(tableFields.id, fieldIds), isNull(tableFields.archived_at)),
      );
    if (
      fields.length !== fieldIds.length ||
      fields.some((field) => field.type === 'formula' || field.type === 'rollup' || field.type === 'attachment')
    ) {
      throw new TablesValidationError(
        'Form fields must be active, writable, non-attachment fields on the target table',
      );
    }
    const text = (value: string | undefined, fallback: string, max: number) =>
      value === undefined ? fallback : value.trim().slice(0, max);
    return {
      version: 1,
      title: text(input.title, '', 120),
      description: text(input.description, '', 2_000),
      fieldIds,
      submitLabel: text(input.submitLabel, 'Submit', 60),
      successMessage: text(input.successMessage, 'Submitted successfully.', 500),
    };
  };

  const normalizeAutomationConfig = async (
    baseId: number,
    tableId: number,
    input: TableAutomationConfig,
  ): Promise<TableAutomationConfig> => {
    if (!input || typeof input !== 'object' || !Array.isArray(input.actions)) {
      throw new TablesValidationError('Automation config requires actions');
    }
    if (input.actions.length < 1 || input.actions.length > 10) {
      throw new TablesValidationError('Automation supports 1-10 actions');
    }
    if (input.condition) {
      validateQueryShape({ where: input.condition });
      if (input.condition.clauses.length > MAX_QUERY_CLAUSES) {
        throw new TablesValidationError(`Automation condition supports at most ${MAX_QUERY_CLAUSES} clauses`);
      }
      const fields = await db
        .select()
        .from(tableFields)
        .where(and(eq(tableFields.table_id, tableId), isNull(tableFields.archived_at)));
      const fieldIds = new Set(fields.map((field) => field.id));
      if (input.condition.clauses.some((clause) => !fieldIds.has(clause.fieldId))) {
        throw new TablesValidationError('Automation condition references an unavailable field');
      }
    }
    const actions: TableAutomationAction[] = [];
    for (const action of input.actions) {
      if (action.type === 'update_record') {
        if (!action.values || typeof action.values !== 'object' || Array.isArray(action.values)) {
          throw new TablesValidationError('update_record action requires values');
        }
        actions.push({ type: 'update_record', values: action.values });
      } else if (action.type === 'create_record') {
        const [targetTable] = await db.select().from(tableTables).where(eq(tableTables.id, action.tableId)).limit(1);
        if (!targetTable || targetTable.base_id !== baseId || targetTable.archived_at) {
          throw new TablesValidationError('create_record target must be an active table in the same Base');
        }
        actions.push({ type: 'create_record', tableId: action.tableId, values: action.values });
      } else if (action.type === 'notify') {
        const userIds = [...new Set(action.userIds)];
        if (userIds.length < 1 || userIds.length > 50) {
          throw new TablesValidationError('notify action requires 1-50 recipients');
        }
        const recipients = await db
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, userIds), eq(users.status, 'active'), inArray(users.role, ['team', 'super'])));
        if (recipients.length !== userIds.length) {
          throw new TablesValidationError('notify recipients must be active internal users');
        }
        actions.push({
          type: 'notify',
          userIds,
          title: trimmed(action.title, 'Notification title', 120),
          message: trimmed(action.message, 'Notification message', 2_000),
        });
      } else {
        throw new TablesValidationError('Unsupported automation action');
      }
    }
    return { version: 1, ...(input.condition ? { condition: input.condition } : {}), actions };
  };

  const writeSchemaVersion = async (
    tx: TablesTransaction,
    tableId: number,
    changeType: TableSchemaChangeType,
    changedBy: string,
  ): Promise<number> => {
    const [table] = await tx
      .select({ schema_revision: tableTables.schema_revision })
      .from(tableTables)
      .where(eq(tableTables.id, tableId))
      .limit(1)
      .for('update');
    if (!table) throw new TablesValidationError(`Table ${tableId} is unavailable`);
    const fields = await tx
      .select()
      .from(tableFields)
      .where(eq(tableFields.table_id, tableId))
      .orderBy(asc(tableFields.position), asc(tableFields.id));
    const nextVersion = table.schema_revision + 1;
    const now = nowIso();
    await tx
      .update(tableTables)
      .set({ schema_revision: nextVersion, updated_at: now })
      .where(eq(tableTables.id, tableId));
    await tx.insert(tableSchemaVersions).values({
      table_id: tableId,
      version: nextVersion,
      schema_snapshot: buildSchemaSnapshot(tableId, fields),
      change_type: changeType,
      changed_by: changedBy,
      created_at: now,
    });
    return nextVersion;
  };

  const syncFieldDependencies = async (
    tx: TablesTransaction,
    field: TableFieldRow,
    config: TableFieldConfig,
  ): Promise<void> => {
    await tx.delete(tableFieldDependencies).where(eq(tableFieldDependencies.field_id, field.id));
    const dependencies =
      field.type === 'formula' && config.formula
        ? [...formulaFieldIds(config.formula.expression)].map((dependsOnFieldId) => ({
            field_id: field.id,
            depends_on_field_id: dependsOnFieldId,
            dependency_type: 'formula' as const,
          }))
        : field.type === 'rollup' && config.rollup
          ? [config.rollup.relationFieldId, config.rollup.targetFieldId].map((dependsOnFieldId) => ({
              field_id: field.id,
              depends_on_field_id: dependsOnFieldId,
              dependency_type: 'rollup' as const,
            }))
          : [];
    if (dependencies.length > 0) await tx.insert(tableFieldDependencies).values(dependencies);
  };

  const syncRecordEdges = async (
    tx: TablesTransaction,
    recordId: number,
    values: TableRecordValues,
    fields: TableFieldRow[],
    userId: string,
  ): Promise<void> => {
    await tx.delete(tableRecordLinks).where(eq(tableRecordLinks.source_record_id, recordId));
    await tx.delete(tableRecordAttachments).where(eq(tableRecordAttachments.record_id, recordId));
    const now = nowIso();
    const links: Array<typeof tableRecordLinks.$inferInsert> = [];
    const attachments: Array<typeof tableRecordAttachments.$inferInsert> = [];
    for (const field of fields) {
      const value = values[String(field.id)];
      if (field.type === 'relation') {
        const ids = Array.isArray(value) ? value : typeof value === 'number' ? [value] : [];
        ids.forEach((targetRecordId, position) => {
          if (typeof targetRecordId !== 'number') return;
          links.push({
            field_id: field.id,
            source_record_id: recordId,
            target_record_id: targetRecordId,
            position,
            created_by: userId,
            created_at: now,
          });
        });
      } else if (field.type === 'attachment' && Array.isArray(value)) {
        value.forEach((driveFileId, position) => {
          if (typeof driveFileId !== 'number') return;
          attachments.push({
            record_id: recordId,
            field_id: field.id,
            drive_file_id: driveFileId,
            position,
            created_by: userId,
            created_at: now,
          });
        });
      }
    }
    if (links.length > 0) await tx.insert(tableRecordLinks).values(links);
    if (attachments.length > 0) await tx.insert(tableRecordAttachments).values(attachments);
  };

  const validateModelConfig = async (
    tableId: number,
    type: TableFieldType,
    config: TableFieldConfig,
    fieldId?: number,
  ): Promise<void> => {
    if (type === 'relation') {
      const [source, target] = await Promise.all([
        db.select().from(tableTables).where(eq(tableTables.id, tableId)).limit(1),
        db.select().from(tableTables).where(eq(tableTables.id, config.relation!.targetTableId)).limit(1),
      ]);
      if (!source[0] || !target[0] || source[0].base_id !== target[0].base_id || target[0].archived_at) {
        throw new TablesValidationError('Relation target must be an active table in the same Base');
      }
      return;
    }
    if (type === 'formula') {
      const fields = await db
        .select()
        .from(tableFields)
        .where(and(eq(tableFields.table_id, tableId), isNull(tableFields.archived_at)));
      const byId = new Map(fields.map((field) => [field.id, field]));
      for (const dependencyId of formulaFieldIds(config.formula!.expression)) {
        const dependency = byId.get(dependencyId);
        if (!dependency || dependency.id === fieldId) {
          throw new TablesValidationError(`Formula field ${dependencyId} is unavailable`);
        }
        if (dependency.type === 'formula' || dependency.type === 'rollup') {
          throw new TablesValidationError('Formula fields may reference stored fields only');
        }
      }
      return;
    }
    if (type === 'rollup') {
      const rollup = config.rollup!;
      const [relationField] = await db
        .select()
        .from(tableFields)
        .where(
          and(
            eq(tableFields.id, rollup.relationFieldId),
            eq(tableFields.table_id, tableId),
            isNull(tableFields.archived_at),
          ),
        )
        .limit(1);
      if (!relationField || relationField.type !== 'relation') {
        throw new TablesValidationError('Rollup relationFieldId must reference a relation field on this table');
      }
      const relation = parseTableFieldConfig(relationField).relation;
      const [targetField] = await db
        .select()
        .from(tableFields)
        .where(
          and(
            eq(tableFields.id, rollup.targetFieldId),
            eq(tableFields.table_id, relation!.targetTableId),
            isNull(tableFields.archived_at),
          ),
        )
        .limit(1);
      if (!targetField) throw new TablesValidationError('Rollup target field is unavailable');
      const numericTarget =
        targetField.type === 'number' ||
        (targetField.type === 'formula' && parseTableFieldConfig(targetField).formula?.resultType === 'number');
      if (['sum', 'avg', 'min', 'max'].includes(rollup.aggregation) && !numericTarget) {
        throw new TablesValidationError(`${rollup.aggregation} rollups require a numeric target field`);
      }
    }
  };

  const evaluateFormula = (expression: TableFormulaExpression, values: TableRecordValues): unknown => {
    if (expression.type === 'literal') return expression.value;
    if (expression.type === 'field') return values[String(expression.fieldId)] ?? null;
    if (expression.type === 'binary') {
      const left = evaluateFormula(expression.left, values);
      const right = evaluateFormula(expression.right, values);
      if (expression.operator === 'concat') return `${left ?? ''}${right ?? ''}`;
      if (expression.operator === 'and') return Boolean(left) && Boolean(right);
      if (expression.operator === 'or') return Boolean(left) || Boolean(right);
      if (expression.operator === 'eq') return left === right;
      if (expression.operator === 'neq') return left !== right;
      if (expression.operator === 'gt') return Number(left) > Number(right);
      if (expression.operator === 'gte') return Number(left) >= Number(right);
      if (expression.operator === 'lt') return Number(left) < Number(right);
      if (expression.operator === 'lte') return Number(left) <= Number(right);
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return null;
      if (expression.operator === 'add') return leftNumber + rightNumber;
      if (expression.operator === 'subtract') return leftNumber - rightNumber;
      if (expression.operator === 'multiply') return leftNumber * rightNumber;
      return rightNumber === 0 ? null : leftNumber / rightNumber;
    }
    const args = expression.args.map((argument) => evaluateFormula(argument, values));
    if (expression.name === 'if') return args[0] ? (args[1] ?? null) : (args[2] ?? null);
    if (expression.name === 'coalesce') return args.find((value) => value !== null && value !== undefined) ?? null;
    if (expression.name === 'concat') return args.map((value) => value ?? '').join('');
    if (expression.name === 'upper') return String(args[0] ?? '').toUpperCase();
    if (expression.name === 'lower') return String(args[0] ?? '').toLowerCase();
    const value = Number(args[0]);
    const precision = Math.min(Math.max(Number(args[1] ?? 0), 0), 10);
    return Number.isFinite(value) ? Number(value.toFixed(precision)) : null;
  };

  const normalizeFormulaResult = (
    resultType: NonNullable<TableFieldConfig['formula']>['resultType'],
    value: unknown,
  ) => {
    if (value === null || value === undefined) return null;
    if (resultType === 'text') return String(value);
    if (resultType === 'number') {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }
    if (resultType === 'boolean') return Boolean(value);
    if (resultType === 'date') {
      const date = typeof value === 'string' ? value.slice(0, 10) : '';
      return parseDate(date) ? date : null;
    }
    const date = new Date(String(value));
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  };

  const computeRecordValues = async (tableId: number, values: TableRecordValues): Promise<TableRecordValues> => {
    const fields = await db
      .select()
      .from(tableFields)
      .where(and(eq(tableFields.table_id, tableId), isNull(tableFields.archived_at)))
      .orderBy(asc(tableFields.position), asc(tableFields.id));
    const fieldsById = new Map(fields.map((field) => [field.id, field]));
    const computed: TableRecordValues = {};
    for (const field of fields) {
      const config = parseTableFieldConfig(field);
      if (field.type === 'formula' && config.formula) {
        computed[String(field.id)] = normalizeFormulaResult(
          config.formula.resultType,
          evaluateFormula(config.formula.expression, values),
        );
      } else if (field.type === 'rollup' && config.rollup) {
        const relationField = fieldsById.get(config.rollup.relationFieldId);
        const relationValue = values[String(config.rollup.relationFieldId)];
        const recordIds = Array.isArray(relationValue)
          ? relationValue.filter((value): value is number => typeof value === 'number')
          : typeof relationValue === 'number'
            ? [relationValue]
            : [];
        const targetTableId = relationField ? parseTableFieldConfig(relationField).relation?.targetTableId : undefined;
        const targetRecords =
          !targetTableId || recordIds.length === 0
            ? []
            : await db
                .select()
                .from(tableRecords)
                .where(
                  and(
                    eq(tableRecords.table_id, targetTableId),
                    inArray(tableRecords.id, recordIds),
                    isNull(tableRecords.deleted_at),
                  ),
                );
        const targetValues = targetRecords
          .map(
            (record) =>
              ({
                ...record.values,
                ...record.computed_values,
              })[String(config.rollup!.targetFieldId)],
          )
          .filter((value) => value !== null && value !== undefined);
        if (config.rollup.aggregation === 'count') computed[String(field.id)] = targetValues.length;
        else if (config.rollup.aggregation === 'join') {
          computed[String(field.id)] = targetValues.map(String).join(', ');
        } else {
          const numbers = targetValues.map(Number).filter(Number.isFinite);
          if (config.rollup.aggregation === 'sum') {
            computed[String(field.id)] = numbers.reduce((sum, value) => sum + value, 0);
          } else if (config.rollup.aggregation === 'avg') {
            computed[String(field.id)] =
              numbers.length > 0 ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
          } else if (config.rollup.aggregation === 'min') {
            computed[String(field.id)] = numbers.length > 0 ? Math.min(...numbers) : null;
          } else {
            computed[String(field.id)] = numbers.length > 0 ? Math.max(...numbers) : null;
          }
        }
      }
    }
    return computed;
  };

  const recomputeRecord = async (record: TableRecordRow): Promise<TableRecordRow> => {
    const computedValues = await computeRecordValues(record.table_id, record.values);
    const now = nowIso();
    const [updated] = await db
      .update(tableRecords)
      .set({
        computed_values: computedValues,
        computed_revision: record.computed_revision + 1,
        computed_at: now,
      })
      .where(eq(tableRecords.id, record.id))
      .returning();
    return updated ?? record;
  };

  const recomputeTable = async (tableId: number): Promise<void> => {
    const records = await db
      .select()
      .from(tableRecords)
      .where(and(eq(tableRecords.table_id, tableId), isNull(tableRecords.deleted_at)));
    for (const record of records) await recomputeRecord(record);
  };

  const refreshDependentRollups = async (targetTableId: number, targetRecordId: number): Promise<void> => {
    const [targetRecord] = await db
      .select({ revision: tableRecords.revision, deleted_at: tableRecords.deleted_at })
      .from(tableRecords)
      .where(eq(tableRecords.id, targetRecordId))
      .limit(1);
    const targetVersion = `${targetRecord?.revision ?? 0}:${targetRecord?.deleted_at ? 'deleted' : 'active'}`;
    const rollupFields = await db
      .select()
      .from(tableFields)
      .where(and(eq(tableFields.type, 'rollup'), isNull(tableFields.archived_at)));
    for (const rollupField of rollupFields) {
      const rollup = parseTableFieldConfig(rollupField).rollup;
      if (!rollup) continue;
      const [relationField] = await db
        .select()
        .from(tableFields)
        .where(and(eq(tableFields.id, rollup.relationFieldId), isNull(tableFields.archived_at)))
        .limit(1);
      if (!relationField || parseTableFieldConfig(relationField).relation?.targetTableId !== targetTableId) continue;
      const records = await db
        .select()
        .from(tableRecords)
        .where(and(eq(tableRecords.table_id, rollupField.table_id), isNull(tableRecords.deleted_at)));
      for (const record of records) {
        const relationValue = record.values[String(relationField.id)];
        if (
          relationValue === targetRecordId ||
          (Array.isArray(relationValue) && relationValue.includes(targetRecordId))
        ) {
          const now = nowIso();
          const [job] = await db
            .insert(tableRecomputeJobs)
            .values({
              table_id: record.table_id,
              field_id: rollupField.id,
              record_id: record.id,
              status: 'queued',
              idempotency_key: `rollup:${rollupField.id}:${record.id}:${targetRecordId}:${targetVersion}`,
              created_at: now,
            })
            .onConflictDoNothing()
            .returning();
          if (!job) continue;
          await db
            .update(tableRecomputeJobs)
            .set({ status: 'running', attempt: 1, started_at: now })
            .where(eq(tableRecomputeJobs.id, job.id));
          try {
            await recomputeRecord(record);
            await db
              .update(tableRecomputeJobs)
              .set({ status: 'succeeded', finished_at: nowIso() })
              .where(eq(tableRecomputeJobs.id, job.id));
          } catch (error) {
            await db
              .update(tableRecomputeJobs)
              .set({
                status: 'failed',
                error: error instanceof Error ? error.message.slice(0, 2_000) : 'Unknown recompute error',
                finished_at: nowIso(),
              })
              .where(eq(tableRecomputeJobs.id, job.id));
            throw error;
          }
        }
      }
    }
  };

  const createRecordWithContext = async (
    input: CreateTableRecordInput,
    context: TableValidationContext,
  ): Promise<TableRecordRow> => {
    const values = validateValuesWithContext(context, input.values, { requireAll: true });
    const now = nowIso();
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(tableRecords)
        .values({
          table_id: input.table_id,
          values,
          revision: 1,
          created_by: input.user_id,
          updated_by: input.user_id,
          created_at: now,
          updated_at: now,
        })
        .returning();
      await syncRecordEdges(tx, created!.id, values, context.fields, input.user_id);
      return created!;
    });
    return recomputeRecord(row);
  };

  const updateRecordWithContext = async (
    input: UpdateTableRecordInput,
    context: TableValidationContext,
  ): Promise<
    { ok: true; record: TableRecordRow } | { ok: false; reason: 'not_found' | 'conflict'; current?: number }
  > => {
    const rows = await db
      .select()
      .from(tableRecords)
      .where(
        and(
          eq(tableRecords.table_id, input.table_id),
          eq(tableRecords.id, input.record_id),
          isNull(tableRecords.deleted_at),
        ),
      )
      .limit(1);
    const current = rows[0];
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.revision !== input.revision) {
      return { ok: false, reason: 'conflict', current: current.revision };
    }
    const patch = validateValuesWithContext(context, input.values, { requireAll: false });
    const values = validateValuesWithContext(context, { ...current.values, ...patch }, { requireAll: true });
    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .update(tableRecords)
        .set({
          values,
          revision: input.revision + 1,
          updated_by: input.user_id,
          updated_at: nowIso(),
        })
        .where(
          and(
            eq(tableRecords.table_id, input.table_id),
            eq(tableRecords.id, input.record_id),
            eq(tableRecords.revision, input.revision),
            isNull(tableRecords.deleted_at),
          ),
        )
        .returning();
      if (rows[0]) await syncRecordEdges(tx, rows[0].id, values, context.fields, input.user_id);
      return rows[0];
    });
    if (updated) {
      const record = await recomputeRecord(updated);
      await refreshDependentRollups(record.table_id, record.id);
      return { ok: true, record };
    }
    const latest = await db
      .select()
      .from(tableRecords)
      .where(
        and(
          eq(tableRecords.table_id, input.table_id),
          eq(tableRecords.id, input.record_id),
          isNull(tableRecords.deleted_at),
        ),
      )
      .limit(1);
    return latest[0]
      ? { ok: false, reason: 'conflict', current: latest[0].revision }
      : { ok: false, reason: 'not_found' };
  };

  const canUserEditBase = async (baseId: number, userId: string): Promise<boolean> => {
    const [user, base, member, authorization] = await Promise.all([
      db.select().from(users).where(eq(users.id, userId)).limit(1),
      db.select().from(tableBases).where(eq(tableBases.id, baseId)).limit(1),
      db
        .select()
        .from(tableBaseMembers)
        .where(and(eq(tableBaseMembers.base_id, baseId), eq(tableBaseMembers.user_id, userId)))
        .limit(1),
      platform.getAuthorizationSnapshot(userId, 'default'),
    ]);
    if (
      !user[0] ||
      user[0].status !== 'active' ||
      (user[0].role !== 'team' && user[0].role !== 'super') ||
      !base[0] ||
      base[0].archived_at
    ) {
      return false;
    }
    if (!resolveCapability({ capability: 'tables.data.update', ...authorization }).allowed) return false;
    if (user[0].role === 'super' || base[0].owner_id === user[0].id) return true;
    return member[0]?.role === 'owner' || member[0]?.role === 'builder' || member[0]?.role === 'editor';
  };

  const canExecuteAutomation = (rule: TableAutomationRuleRow): Promise<boolean> =>
    canUserEditBase(rule.base_id, rule.execution_user_id);

  const runAutomations = async (eventType: TableAutomationTrigger, record: TableRecordRow): Promise<void> => {
    const [rules, fields] = await Promise.all([
      db
        .select()
        .from(tableAutomationRules)
        .where(
          and(
            eq(tableAutomationRules.table_id, record.table_id),
            eq(tableAutomationRules.status, 'enabled'),
            eq(tableAutomationRules.trigger, eventType),
          ),
        ),
      db
        .select()
        .from(tableFields)
        .where(and(eq(tableFields.table_id, record.table_id), isNull(tableFields.archived_at))),
    ]);
    const recordValues = { ...record.values, ...record.computed_values };
    for (const rule of rules) {
      if (!automationConditionMatches(rule.config.condition, fields, recordValues)) continue;
      const now = nowIso();
      const [outbox] = await db
        .insert(tableAutomationOutbox)
        .values({
          rule_id: rule.id,
          record_id: record.id,
          event_type: eventType,
          payload: { tableId: record.table_id, revision: record.revision },
          status: 'pending',
          idempotency_key: `rule:${rule.id}:${eventType}:${record.id}:${record.revision}`,
          recursion_depth: 0,
          created_at: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!outbox) continue;
      const [run] = await db
        .insert(tableAutomationRuns)
        .values({
          rule_id: rule.id,
          outbox_id: outbox.id,
          status: 'running',
          actions_completed: 0,
          started_at: now,
        })
        .returning();
      await db
        .update(tableAutomationOutbox)
        .set({ status: 'processing' })
        .where(eq(tableAutomationOutbox.id, outbox.id));
      let actionsCompleted = 0;
      try {
        if (!(await canExecuteAutomation(rule))) {
          throw new TablesValidationError('Automation execution user is inactive or lacks Base edit access');
        }
        for (const action of rule.config.actions) {
          if (action.type === 'notify') {
            await db.insert(tableNotifications).values(
              action.userIds.map((userId) => ({
                base_id: rule.base_id,
                user_id: userId,
                rule_id: rule.id,
                record_id: record.id,
                title: action.title,
                message: action.message,
                created_at: nowIso(),
              })),
            );
          } else if (action.type === 'update_record') {
            const currentRows = await db
              .select()
              .from(tableRecords)
              .where(and(eq(tableRecords.id, record.id), isNull(tableRecords.deleted_at)))
              .limit(1);
            if (!currentRows[0]) throw new TablesValidationError('Automation record is unavailable');
            const context = await loadValidationContext(currentRows[0].table_id);
            const result = await updateRecordWithContext(
              {
                table_id: currentRows[0].table_id,
                record_id: currentRows[0].id,
                revision: currentRows[0].revision,
                values: action.values,
                user_id: rule.execution_user_id,
              },
              context,
            );
            if (!result.ok) throw new TablesValidationError(`Automation update failed: ${result.reason}`);
          } else {
            const context = await loadValidationContext(action.tableId);
            await createRecordWithContext(
              {
                table_id: action.tableId,
                values: action.values,
                user_id: rule.execution_user_id,
              },
              context,
            );
          }
          actionsCompleted += 1;
        }
        await Promise.all([
          db
            .update(tableAutomationOutbox)
            .set({ status: 'succeeded', processed_at: nowIso() })
            .where(eq(tableAutomationOutbox.id, outbox.id)),
          db
            .update(tableAutomationRuns)
            .set({ status: 'succeeded', actions_completed: actionsCompleted, finished_at: nowIso() })
            .where(eq(tableAutomationRuns.id, run!.id)),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 2_000) : 'Unknown automation error';
        await Promise.all([
          db
            .update(tableAutomationOutbox)
            .set({ status: 'failed', processed_at: nowIso() })
            .where(eq(tableAutomationOutbox.id, outbox.id)),
          db
            .update(tableAutomationRuns)
            .set({
              status: 'failed',
              actions_completed: actionsCompleted,
              error: message,
              finished_at: nowIso(),
            })
            .where(eq(tableAutomationRuns.id, run!.id)),
        ]);
      }
    }
  };

  const service = {
    async activeInternalUserIds(): Promise<Set<string>> {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.status, 'active'), inArray(users.role, ['team', 'super'])));
      return new Set(rows.map((row) => row.id));
    },

    async getBase(id: number): Promise<TableBaseRow | undefined> {
      const rows = await db.select().from(tableBases).where(eq(tableBases.id, id)).limit(1);
      return rows[0];
    },

    async listBasesForUser(userId: string, search?: string): Promise<TableBaseRow[]> {
      const conditions: SQL[] = [
        isNull(tableBases.archived_at),
        or(
          eq(tableBases.owner_id, userId),
          eq(tableBases.visibility, 'team'),
          sql`EXISTS (
            SELECT 1 FROM table_base_members
            WHERE table_base_members.base_id = ${tableBases.id}
              AND table_base_members.user_id = ${userId}
          )`,
        )!,
      ];
      if (search?.trim()) {
        conditions.push(sql`${tableBases.name} ILIKE ${`%${escapeLike(search.trim())}%`} ESCAPE '\\'`);
      }
      return db
        .select()
        .from(tableBases)
        .where(and(...conditions))
        .orderBy(desc(tableBases.updated_at));
    },

    async createBase(input: CreateTableBaseInput): Promise<TableBaseRow> {
      const now = nowIso();
      return db.transaction(async (tx) => {
        const [base] = await tx
          .insert(tableBases)
          .values({
            name: trimmed(input.name, 'Base name', 120),
            description: input.description?.trim() || null,
            visibility: input.visibility ?? 'private',
            owner_id: input.owner_id,
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
          })
          .returning();
        await tx.insert(tableBaseMembers).values({
          base_id: base!.id,
          user_id: input.owner_id,
          role: 'owner',
          added_by: input.created_by,
          created_at: now,
          updated_at: now,
        });
        return base!;
      });
    },

    async updateBase(id: number, patch: UpdateTableBaseInput): Promise<TableBaseRow | undefined> {
      const values: Partial<TableBaseRow> = { updated_at: nowIso() };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'Base name', 120);
      if (patch.description !== undefined) values.description = patch.description?.trim() || null;
      if (patch.visibility !== undefined) values.visibility = patch.visibility;
      const rows = await db.update(tableBases).set(values).where(eq(tableBases.id, id)).returning();
      return rows[0];
    },

    async archiveBase(id: number): Promise<TableBaseRow | undefined> {
      const now = nowIso();
      const rows = await db
        .update(tableBases)
        .set({ archived_at: now, updated_at: now })
        .where(and(eq(tableBases.id, id), isNull(tableBases.archived_at)))
        .returning();
      return rows[0];
    },

    async restoreBase(id: number): Promise<TableBaseRow | undefined> {
      const rows = await db
        .update(tableBases)
        .set({ archived_at: null, updated_at: nowIso() })
        .where(eq(tableBases.id, id))
        .returning();
      return rows[0];
    },

    async listArchivedBases(): Promise<TableBaseRow[]> {
      return db
        .select()
        .from(tableBases)
        .where(isNotNull(tableBases.archived_at))
        .orderBy(desc(tableBases.archived_at));
    },

    async getBaseMember(baseId: number, userId: string): Promise<TableBaseMemberRow | undefined> {
      const rows = await db
        .select()
        .from(tableBaseMembers)
        .where(and(eq(tableBaseMembers.base_id, baseId), eq(tableBaseMembers.user_id, userId)))
        .limit(1);
      return rows[0];
    },

    async listBaseMembers(baseId: number): Promise<TableBaseMemberRow[]> {
      return db
        .select()
        .from(tableBaseMembers)
        .where(eq(tableBaseMembers.base_id, baseId))
        .orderBy(asc(tableBaseMembers.created_at));
    },

    async upsertBaseMember(input: {
      base_id: number;
      user_id: string;
      role: TableBaseRole;
      added_by: string;
    }): Promise<TableBaseMemberRow> {
      const now = nowIso();
      const [row] = await db
        .insert(tableBaseMembers)
        .values({ ...input, created_at: now, updated_at: now })
        .onConflictDoUpdate({
          target: [tableBaseMembers.base_id, tableBaseMembers.user_id],
          set: { role: input.role, added_by: input.added_by, updated_at: now },
        })
        .returning();
      return row!;
    },

    async removeBaseMember(baseId: number, userId: string): Promise<boolean> {
      const rows = await db
        .delete(tableBaseMembers)
        .where(and(eq(tableBaseMembers.base_id, baseId), eq(tableBaseMembers.user_id, userId)))
        .returning({ id: tableBaseMembers.id });
      return rows.length > 0;
    },

    async getTable(id: number): Promise<TableDefinitionRow | undefined> {
      const rows = await db.select().from(tableTables).where(eq(tableTables.id, id)).limit(1);
      return rows[0];
    },

    async listTables(baseId: number): Promise<TableDefinitionRow[]> {
      return db
        .select()
        .from(tableTables)
        .where(and(eq(tableTables.base_id, baseId), isNull(tableTables.archived_at)))
        .orderBy(asc(tableTables.position), asc(tableTables.id));
    },

    async createTable(input: CreateTableDefinitionInput): Promise<TableSchemaResult> {
      const now = nowIso();
      return db.transaction(async (tx) => {
        const [{ nextPosition }] = await tx
          .select({ nextPosition: sql<number>`coalesce(max(${tableTables.position}), -1) + 1` })
          .from(tableTables)
          .where(eq(tableTables.base_id, input.base_id));
        const [table] = await tx
          .insert(tableTables)
          .values({
            base_id: input.base_id,
            name: trimmed(input.name, 'Table name', 120),
            description: input.description?.trim() || null,
            position: Number(nextPosition),
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
          })
          .returning();
        const [field] = await tx
          .insert(tableFields)
          .values({
            table_id: table!.id,
            name: 'Name',
            type: 'text',
            required: true,
            is_primary: true,
            config: JSON.stringify({ version: 1 } satisfies TableFieldConfig),
            position: 0,
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
          })
          .returning();
        const [view] = await tx
          .insert(tableViews)
          .values({
            table_id: table!.id,
            name: 'Grid',
            type: 'grid',
            scope: 'shared',
            config: JSON.stringify({ version: 1, fieldIds: [field!.id] } satisfies TableViewConfig),
            position: 0,
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
          })
          .returning();
        await tx.insert(tableSchemaVersions).values({
          table_id: table!.id,
          version: 1,
          schema_snapshot: buildSchemaSnapshot(table!.id, [field!]),
          change_type: 'created',
          changed_by: input.created_by,
          created_at: now,
        });
        return { table: table!, fields: [field!], views: [view!] };
      });
    },

    async updateTable(
      id: number,
      patch: { name?: string; description?: string | null; position?: number },
    ): Promise<TableDefinitionRow | undefined> {
      const values: Partial<TableDefinitionRow> = { updated_at: nowIso() };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'Table name', 120);
      if (patch.description !== undefined) values.description = patch.description?.trim() || null;
      if (patch.position !== undefined) values.position = patch.position;
      const rows = await db.update(tableTables).set(values).where(eq(tableTables.id, id)).returning();
      return rows[0];
    },

    /**
     * Archiving a table hides it everywhere (listTables/getSchema already filter
     * on archived_at) but touches no record, link or field. Relations pointing
     * at it keep their rows; creating new links to an archived table is already
     * refused upstream, and its rollups simply stop refreshing.
     */
    async archiveTable(id: number): Promise<TableDefinitionRow | undefined> {
      const now = nowIso();
      const rows = await db
        .update(tableTables)
        .set({ archived_at: now, updated_at: now })
        .where(and(eq(tableTables.id, id), isNull(tableTables.archived_at)))
        .returning();
      return rows[0];
    },

    async restoreTable(id: number): Promise<TableDefinitionRow | undefined> {
      const rows = await db
        .update(tableTables)
        .set({ archived_at: null, updated_at: nowIso() })
        .where(eq(tableTables.id, id))
        .returning();
      return rows[0];
    },

    async listArchivedTables(baseId?: number): Promise<TableDefinitionRow[]> {
      const conditions: SQL[] = [isNotNull(tableTables.archived_at)];
      if (baseId !== undefined) conditions.push(eq(tableTables.base_id, baseId));
      return db
        .select()
        .from(tableTables)
        .where(and(...conditions))
        .orderBy(desc(tableTables.archived_at));
    },

    async getField(id: number): Promise<TableFieldRow | undefined> {
      const rows = await db.select().from(tableFields).where(eq(tableFields.id, id)).limit(1);
      return rows[0];
    },

    async listSchemaVersions(tableId: number): Promise<TableSchemaVersionRow[]> {
      return db
        .select()
        .from(tableSchemaVersions)
        .where(eq(tableSchemaVersions.table_id, tableId))
        .orderBy(desc(tableSchemaVersions.version));
    },

    async getSchemaVersion(tableId: number, version: number): Promise<TableSchemaVersionRow | undefined> {
      const rows = await db
        .select()
        .from(tableSchemaVersions)
        .where(and(eq(tableSchemaVersions.table_id, tableId), eq(tableSchemaVersions.version, version)))
        .limit(1);
      return rows[0];
    },

    async listFields(tableId: number, includeArchived = false): Promise<TableFieldRow[]> {
      const conditions = [eq(tableFields.table_id, tableId)];
      if (!includeArchived) conditions.push(isNull(tableFields.archived_at));
      return db
        .select()
        .from(tableFields)
        .where(and(...conditions))
        .orderBy(asc(tableFields.position), asc(tableFields.id));
    },

    async listFieldDependencies(fieldId: number): Promise<TableFieldDependencyRow[]> {
      return db
        .select()
        .from(tableFieldDependencies)
        .where(eq(tableFieldDependencies.field_id, fieldId))
        .orderBy(asc(tableFieldDependencies.depends_on_field_id));
    },

    async createField(input: CreateTableFieldInput): Promise<TableFieldRow> {
      validateFieldType(input.type);
      const config = validateTableFieldConfig(input.type, input.config ?? {});
      await validateModelConfig(input.table_id, input.type, config);
      const now = nowIso();
      const row = await db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(tableFields)
          .where(and(eq(tableFields.table_id, input.table_id), isNull(tableFields.archived_at)))
          .orderBy(asc(tableFields.position), asc(tableFields.id));
        if (current.length >= MAX_FIELDS) {
          throw new TablesValidationError(`A table supports at most ${MAX_FIELDS} fields`);
        }
        const nextPosition = input.position ?? (current.at(-1)?.position ?? -1) + 1;
        const [row] = await tx
          .insert(tableFields)
          .values({
            table_id: input.table_id,
            name: trimmed(input.name, 'Field name', 120),
            type: input.type,
            required: input.required ?? false,
            config: JSON.stringify(config),
            position: nextPosition,
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
          })
          .returning();
        await syncFieldDependencies(tx, row!, config);
        await writeSchemaVersion(tx, input.table_id, 'field_created', input.created_by);
        return row!;
      });
      if (input.type === 'formula' || input.type === 'rollup') await recomputeTable(input.table_id);
      return row;
    },

    async updateField(id: number, patch: UpdateTableFieldInput): Promise<TableFieldRow | undefined> {
      const existing = await service.getField(id);
      if (!existing || existing.archived_at) return undefined;
      const normalizedConfig =
        patch.config === undefined ? undefined : validateTableFieldConfig(existing.type, patch.config);
      if (normalizedConfig) {
        await validateModelConfig(existing.table_id, existing.type, normalizedConfig, existing.id);
      }
      const row = await db.transaction(async (tx) => {
        const [field] = await tx.select().from(tableFields).where(eq(tableFields.id, id)).limit(1);
        if (!field || field.archived_at) return undefined;
        const values: Partial<TableFieldRow> = { updated_at: nowIso() };
        if (patch.name !== undefined) values.name = trimmed(patch.name, 'Field name', 120);
        if (patch.required !== undefined) values.required = field.is_primary ? true : patch.required;
        if (normalizedConfig !== undefined) values.config = JSON.stringify(normalizedConfig);
        if (patch.position !== undefined) values.position = patch.position;
        const rows = await tx.update(tableFields).set(values).where(eq(tableFields.id, id)).returning();
        await syncFieldDependencies(tx, rows[0]!, normalizedConfig ?? parseTableFieldConfig(rows[0]!));
        await writeSchemaVersion(tx, field.table_id, 'field_updated', patch.updated_by);
        return rows[0];
      });
      if (row && (row.type === 'formula' || row.type === 'rollup')) await recomputeTable(row.table_id);
      return row;
    },

    async archiveField(id: number, userId: string): Promise<TableFieldRow | undefined> {
      const row = await db.transaction(async (tx) => {
        const [field] = await tx.select().from(tableFields).where(eq(tableFields.id, id)).limit(1);
        if (!field || field.archived_at || field.is_primary) return undefined;
        const now = nowIso();
        const rows = await tx
          .update(tableFields)
          .set({ archived_at: now, updated_at: now })
          .where(eq(tableFields.id, id))
          .returning();
        await tx
          .delete(tableFieldDependencies)
          .where(
            or(eq(tableFieldDependencies.field_id, field.id), eq(tableFieldDependencies.depends_on_field_id, field.id)),
          );
        await writeSchemaVersion(tx, field.table_id, 'field_archived', userId);
        return rows[0];
      });
      if (row && (row.type === 'formula' || row.type === 'rollup')) await recomputeTable(row.table_id);
      return row;
    },

    async listViews(tableId: number, userId?: string): Promise<TableViewRow[]> {
      const visibility = userId
        ? or(eq(tableViews.scope, 'shared'), eq(tableViews.owner_id, userId))
        : eq(tableViews.scope, 'shared');
      return db
        .select()
        .from(tableViews)
        .where(and(eq(tableViews.table_id, tableId), visibility))
        .orderBy(asc(tableViews.position), asc(tableViews.id));
    },

    async getView(id: number, userId?: string): Promise<TableViewRow | undefined> {
      const visibility = userId ? or(eq(tableViews.scope, 'shared'), eq(tableViews.owner_id, userId)) : undefined;
      const rows = await db
        .select()
        .from(tableViews)
        .where(visibility ? and(eq(tableViews.id, id), visibility) : eq(tableViews.id, id))
        .limit(1);
      return rows[0];
    },

    async createView(input: CreateTableViewInput): Promise<TableViewRow> {
      if (input.scope === 'personal' && !input.owner_id) {
        throw new TablesValidationError('Personal views require owner_id');
      }
      const now = nowIso();
      const [row] = await db
        .insert(tableViews)
        .values({
          table_id: input.table_id,
          name: trimmed(input.name, 'View name', 120),
          type: 'grid',
          scope: input.scope ?? 'shared',
          owner_id: input.scope === 'personal' ? input.owner_id : null,
          config: JSON.stringify({ ...(input.config ?? {}), version: 1 } satisfies TableViewConfig),
          position: input.position ?? 0,
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async updateView(
      id: number,
      patch: UpdateTableViewInput,
      userId?: string,
    ): Promise<TableRevisionResult<TableViewRow>> {
      const current = await service.getView(id, userId);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.revision !== patch.revision) {
        return { ok: false, reason: 'conflict', current: current.revision };
      }
      const values: Partial<TableViewRow> = {
        revision: patch.revision + 1,
        updated_at: nowIso(),
      };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'View name', 120);
      if (patch.config !== undefined) {
        values.config = JSON.stringify({ ...patch.config, version: 1 } satisfies TableViewConfig);
      }
      if (patch.position !== undefined) values.position = patch.position;
      const rows = await db
        .update(tableViews)
        .set(values)
        .where(and(eq(tableViews.id, id), eq(tableViews.revision, patch.revision)))
        .returning();
      if (rows[0]) return { ok: true, value: rows[0] };
      const latest = await service.getView(id, userId);
      return latest ? { ok: false, reason: 'conflict', current: latest.revision } : { ok: false, reason: 'not_found' };
    },

    async getSchema(tableId: number, userId?: string): Promise<TableSchemaResult | undefined> {
      const table = await service.getTable(tableId);
      if (!table || table.archived_at) return undefined;
      const [fields, views] = await Promise.all([service.listFields(tableId), service.listViews(tableId, userId)]);
      return { table, fields, views };
    },

    async listForms(tableId: number): Promise<TableFormRow[]> {
      return db.select().from(tableForms).where(eq(tableForms.table_id, tableId)).orderBy(asc(tableForms.id));
    },

    async getForm(id: number): Promise<TableFormRow | undefined> {
      const rows = await db.select().from(tableForms).where(eq(tableForms.id, id)).limit(1);
      return rows[0];
    },

    async createForm(input: CreateTableFormInput): Promise<TableFormRow> {
      const now = nowIso();
      const config = await normalizeFormConfig(input.table_id, input.config);
      const [row] = await db
        .insert(tableForms)
        .values({
          table_id: input.table_id,
          name: trimmed(input.name, 'Form name', 120),
          status: input.status ?? 'draft',
          config,
          revision: 1,
          created_by: input.user_id,
          updated_by: input.user_id,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async updateForm(id: number, patch: UpdateTableFormInput): Promise<TableRevisionResult<TableFormRow>> {
      const current = await service.getForm(id);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.revision !== patch.revision) {
        return { ok: false, reason: 'conflict', current: current.revision };
      }
      const values: Partial<TableFormRow> = {
        revision: patch.revision + 1,
        updated_by: patch.user_id,
        updated_at: nowIso(),
      };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'Form name', 120);
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.config !== undefined) values.config = await normalizeFormConfig(current.table_id, patch.config);
      const rows = await db
        .update(tableForms)
        .set(values)
        .where(and(eq(tableForms.id, id), eq(tableForms.revision, patch.revision)))
        .returning();
      if (rows[0]) return { ok: true, value: rows[0] };
      const latest = await service.getForm(id);
      return latest ? { ok: false, reason: 'conflict', current: latest.revision } : { ok: false, reason: 'not_found' };
    },

    async submitForm(formId: number, values: TableRecordValues, userId: string): Promise<TableRecordRow> {
      const form = await service.getForm(formId);
      if (!form || form.status !== 'published') throw new TablesValidationError('Form is not published');
      const allowed = new Set(form.config.fieldIds.map(String));
      if (Object.keys(values).some((fieldId) => !allowed.has(fieldId))) {
        throw new TablesValidationError('Form submission contains a field that is not published');
      }
      return service.createRecord({ table_id: form.table_id, values, user_id: userId });
    },

    async listAutomationRules(baseId: number): Promise<TableAutomationRuleRow[]> {
      return db
        .select()
        .from(tableAutomationRules)
        .where(eq(tableAutomationRules.base_id, baseId))
        .orderBy(asc(tableAutomationRules.id));
    },

    async getAutomationRule(id: number): Promise<TableAutomationRuleRow | undefined> {
      const rows = await db.select().from(tableAutomationRules).where(eq(tableAutomationRules.id, id)).limit(1);
      return rows[0];
    },

    async createAutomationRule(input: CreateTableAutomationInput): Promise<TableAutomationRuleRow> {
      if (!['record_created', 'record_updated'].includes(input.trigger)) {
        throw new TablesValidationError('Unsupported automation trigger');
      }
      const [table] = await db.select().from(tableTables).where(eq(tableTables.id, input.table_id)).limit(1);
      if (!table || table.base_id !== input.base_id || table.archived_at) {
        throw new TablesValidationError('Automation table must belong to this Base');
      }
      if (!(await canUserEditBase(input.base_id, input.execution_user_id))) {
        throw new TablesValidationError('Automation execution user must have Base edit access');
      }
      const config = await normalizeAutomationConfig(input.base_id, input.table_id, input.config);
      const now = nowIso();
      const [row] = await db
        .insert(tableAutomationRules)
        .values({
          base_id: input.base_id,
          table_id: input.table_id,
          name: trimmed(input.name, 'Automation name', 120),
          status: input.status ?? 'disabled',
          trigger: input.trigger,
          config,
          execution_user_id: input.execution_user_id,
          revision: 1,
          created_by: input.user_id,
          updated_by: input.user_id,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async updateAutomationRule(
      id: number,
      patch: UpdateTableAutomationInput,
    ): Promise<TableRevisionResult<TableAutomationRuleRow>> {
      const current = await service.getAutomationRule(id);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.revision !== patch.revision) {
        return { ok: false, reason: 'conflict', current: current.revision };
      }
      const executionUserId = patch.execution_user_id ?? current.execution_user_id;
      if (!(await canUserEditBase(current.base_id, executionUserId))) {
        throw new TablesValidationError('Automation execution user must have Base edit access');
      }
      const values: Partial<TableAutomationRuleRow> = {
        revision: patch.revision + 1,
        updated_by: patch.user_id,
        updated_at: nowIso(),
      };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'Automation name', 120);
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.trigger !== undefined) values.trigger = patch.trigger;
      if (patch.execution_user_id !== undefined) values.execution_user_id = patch.execution_user_id;
      if (patch.config !== undefined) {
        values.config = await normalizeAutomationConfig(current.base_id, current.table_id, patch.config);
      }
      const rows = await db
        .update(tableAutomationRules)
        .set(values)
        .where(and(eq(tableAutomationRules.id, id), eq(tableAutomationRules.revision, patch.revision)))
        .returning();
      if (rows[0]) return { ok: true, value: rows[0] };
      const latest = await service.getAutomationRule(id);
      return latest ? { ok: false, reason: 'conflict', current: latest.revision } : { ok: false, reason: 'not_found' };
    },

    async listAutomationRuns(ruleId: number, limit = 50): Promise<TableAutomationRunRow[]> {
      return db
        .select()
        .from(tableAutomationRuns)
        .where(eq(tableAutomationRuns.rule_id, ruleId))
        .orderBy(desc(tableAutomationRuns.started_at))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    async listNotifications(userId: string, limit = 100): Promise<TableNotificationRow[]> {
      return db
        .select()
        .from(tableNotifications)
        .where(eq(tableNotifications.user_id, userId))
        .orderBy(desc(tableNotifications.created_at))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    async markNotificationRead(id: number, userId: string): Promise<TableNotificationRow | undefined> {
      const rows = await db
        .update(tableNotifications)
        .set({ read_at: nowIso() })
        .where(and(eq(tableNotifications.id, id), eq(tableNotifications.user_id, userId)))
        .returning();
      return rows[0];
    },

    async validatedValues(
      tableId: number,
      values: TableRecordValues,
      options: { requireAll: boolean },
    ): Promise<TableRecordValues> {
      return validateValuesWithContext(await loadValidationContext(tableId), values, options);
    },

    async createRecord(input: CreateTableRecordInput): Promise<TableRecordRow> {
      const record = await createRecordWithContext(input, await loadValidationContext(input.table_id));
      await runAutomations('record_created', record);
      return record;
    },

    async getRecord(tableId: number, recordId: number): Promise<TableRecordRow | undefined> {
      const rows = await db
        .select()
        .from(tableRecords)
        .where(and(eq(tableRecords.table_id, tableId), eq(tableRecords.id, recordId), isNull(tableRecords.deleted_at)))
        .limit(1);
      return rows[0];
    },

    async getRecordById(recordId: number): Promise<TableRecordRow | undefined> {
      const rows = await db.select().from(tableRecords).where(eq(tableRecords.id, recordId)).limit(1);
      return rows[0];
    },

    async listRecordLinks(fieldId: number, sourceRecordId: number): Promise<TableRecordLinkRow[]> {
      return db
        .select()
        .from(tableRecordLinks)
        .where(and(eq(tableRecordLinks.field_id, fieldId), eq(tableRecordLinks.source_record_id, sourceRecordId)))
        .orderBy(asc(tableRecordLinks.position));
    },

    async listRecordAttachments(recordId: number, fieldId: number): Promise<TableRecordAttachmentRow[]> {
      return db
        .select()
        .from(tableRecordAttachments)
        .where(and(eq(tableRecordAttachments.record_id, recordId), eq(tableRecordAttachments.field_id, fieldId)))
        .orderBy(asc(tableRecordAttachments.position));
    },

    async listRecomputeJobs(recordId: number): Promise<TableRecomputeJobRow[]> {
      return db
        .select()
        .from(tableRecomputeJobs)
        .where(eq(tableRecomputeJobs.record_id, recordId))
        .orderBy(desc(tableRecomputeJobs.created_at));
    },

    async updateRecord(
      input: UpdateTableRecordInput,
    ): Promise<
      { ok: true; record: TableRecordRow } | { ok: false; reason: 'not_found' | 'conflict'; current?: number }
    > {
      const result = await updateRecordWithContext(input, await loadValidationContext(input.table_id));
      if (result.ok) await runAutomations('record_updated', result.record);
      return result;
    },

    async deleteRecord(input: {
      table_id: number;
      record_id: number;
      revision: number;
      user_id: string;
    }): Promise<
      { ok: true; record: TableRecordRow } | { ok: false; reason: 'not_found' | 'conflict'; current?: number }
    > {
      const current = await service.getRecord(input.table_id, input.record_id);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.revision !== input.revision) return { ok: false, reason: 'conflict', current: current.revision };
      const now = nowIso();
      const rows = await db
        .update(tableRecords)
        .set({
          deleted_at: now,
          updated_at: now,
          updated_by: input.user_id,
          revision: input.revision + 1,
        })
        .where(
          and(
            eq(tableRecords.table_id, input.table_id),
            eq(tableRecords.id, input.record_id),
            eq(tableRecords.revision, input.revision),
            isNull(tableRecords.deleted_at),
          ),
        )
        .returning();
      if (rows[0]) {
        await refreshDependentRollups(rows[0].table_id, rows[0].id);
        return { ok: true, record: rows[0] };
      }
      const latest = await service.getRecord(input.table_id, input.record_id);
      return latest ? { ok: false, reason: 'conflict', current: latest.revision } : { ok: false, reason: 'not_found' };
    },

    /**
     * The recycle bin feed. Deliberately not part of the bounded record query
     * AST: deleted rows are a maintenance view, not data anyone should filter,
     * sort or hand to an agent.
     */
    async listDeletedRecords(tableId: number, limit = 100): Promise<TableRecordRow[]> {
      return db
        .select()
        .from(tableRecords)
        .where(and(eq(tableRecords.table_id, tableId), isNotNull(tableRecords.deleted_at)))
        .orderBy(desc(tableRecords.updated_at))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    async restoreRecord(input: {
      table_id: number;
      record_id: number;
      user_id: string;
    }): Promise<{ ok: true; record: TableRecordRow } | { ok: false; reason: 'not_found' }> {
      const now = nowIso();
      const rows = await db
        .update(tableRecords)
        .set({
          deleted_at: null,
          updated_at: now,
          updated_by: input.user_id,
          revision: sql`${tableRecords.revision} + 1`,
        })
        .where(
          and(
            eq(tableRecords.table_id, input.table_id),
            eq(tableRecords.id, input.record_id),
            isNotNull(tableRecords.deleted_at),
          ),
        )
        .returning();
      if (!rows[0]) return { ok: false, reason: 'not_found' };
      await refreshDependentRollups(rows[0].table_id, rows[0].id);
      return { ok: true, record: rows[0] };
    },

    async recordQueryParts(
      tableId: number,
      query: TableQuery,
    ): Promise<{
      where: SQL;
      order: SQL[];
      limit: number;
      offset: number;
      fingerprint: string;
    }> {
      validateQueryShape(query);
      const limit = query.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
        throw new TablesValidationError(`limit must be between 1 and ${MAX_QUERY_LIMIT}`);
      }
      if (query.where && query.where.clauses.length > MAX_QUERY_CLAUSES) {
        throw new TablesValidationError(`where supports at most ${MAX_QUERY_CLAUSES} clauses`);
      }
      if (query.sort && query.sort.length > MAX_QUERY_SORTS) {
        throw new TablesValidationError(`sort supports at most ${MAX_QUERY_SORTS} fields`);
      }
      if (query.search && query.search.length > 200) {
        throw new TablesValidationError('search exceeds 200 characters');
      }
      const fields = await service.listFields(tableId);
      const byId = new Map(fields.map((field) => [field.id, field]));
      const activeUserIds = await service.activeInternalUserIds();
      const conditions: SQL[] = [eq(tableRecords.table_id, tableId), isNull(tableRecords.deleted_at)];

      if (query.where) {
        const clauses = query.where.clauses.map((clause) => {
          const field = byId.get(clause.fieldId);
          if (!field) throw new TablesValidationError(`Field ${clause.fieldId} is unavailable on table ${tableId}`);
          return clauseExpression(clause, field, activeUserIds);
        });
        if (clauses.length > 0) {
          conditions.push(query.where.combinator === 'or' ? or(...clauses)! : and(...clauses)!);
        }
      }

      if (query.search?.trim()) {
        const searchable = fields.filter((field) => {
          const valueType = queryValueField(field).type;
          return valueType === 'text' || valueType === 'long_text';
        });
        if (searchable.length === 0) {
          conditions.push(sql`false`);
        } else {
          const pattern = `%${escapeLike(query.search.trim())}%`;
          conditions.push(
            or(...searchable.map((field) => sql`${recordFieldText(String(field.id))} ILIKE ${pattern} ESCAPE '\\'`))!,
          );
        }
      }

      const order: SQL[] = [];
      for (const sort of query.sort ?? []) {
        let expression: SQL;
        if (sort.systemField === 'created_at') expression = sql`${tableRecords.created_at}`;
        else if (sort.systemField === 'updated_at') expression = sql`${tableRecords.updated_at}`;
        else if (sort.fieldId) {
          const field = byId.get(sort.fieldId);
          if (!field) throw new TablesValidationError(`Sort field ${sort.fieldId} is unavailable`);
          const valueField = queryValueField(field);
          expression =
            valueField.type === 'number'
              ? sql`NULLIF(${recordFieldText(String(field.id))}, '')::numeric`
              : recordFieldText(String(field.id));
        } else {
          throw new TablesValidationError('Each sort requires fieldId or systemField');
        }
        order.push(sort.direction === 'desc' ? desc(expression) : asc(expression));
      }
      order.push(asc(tableRecords.id));
      const fingerprint = queryFingerprint(tableId, query);
      return {
        where: and(...conditions)!,
        order,
        limit,
        offset: decodeCursor(query.cursor, fingerprint),
        fingerprint,
      };
    },

    async queryRecords(tableId: number, query: TableQuery = {}): Promise<TableRecordQueryResult> {
      const parts = await service.recordQueryParts(tableId, query);
      const [records, countRows] = await Promise.all([
        db
          .select()
          .from(tableRecords)
          .where(parts.where)
          .orderBy(...parts.order)
          .limit(parts.limit)
          .offset(parts.offset),
        db
          .select({ count: sql<number>`count(*)` })
          .from(tableRecords)
          .where(parts.where),
      ]);
      const total = Number(countRows[0]?.count ?? 0);
      const nextOffset = parts.offset + records.length;
      return {
        records,
        total,
        nextCursor: nextOffset < total ? encodeCursor(nextOffset, parts.fingerprint) : null,
      };
    },

    async validateBatchRecords(input: {
      table_id: number;
      items: BatchUpsertTableRecordItem[];
    }): Promise<TableBatchValidationResult[]> {
      if (input.items.length < 1 || input.items.length > MAX_BATCH_RECORDS) {
        throw new TablesValidationError(`batch supports 1-${MAX_BATCH_RECORDS} records`);
      }
      const context = await loadValidationContext(input.table_id);
      const recordIds = [
        ...new Set(
          input.items
            .map((item) => item.record_id)
            .filter((recordId): recordId is number => typeof recordId === 'number'),
        ),
      ];
      const existing =
        recordIds.length === 0
          ? []
          : await db
              .select()
              .from(tableRecords)
              .where(
                and(
                  eq(tableRecords.table_id, input.table_id),
                  inArray(tableRecords.id, recordIds),
                  isNull(tableRecords.deleted_at),
                ),
              );
      const byRecordId = new Map(existing.map((record) => [record.id, record]));
      return input.items.map((item, index): TableBatchValidationResult => {
        try {
          if (item.record_id == null) {
            validateValuesWithContext(context, item.values, { requireAll: true });
            return { index, ok: true };
          }
          const current = byRecordId.get(item.record_id);
          if (!current) return { index, ok: false, reason: 'not_found' };
          if (!item.revision) {
            return { index, ok: false, reason: 'invalid', message: 'revision is required' };
          }
          if (current.revision !== item.revision) {
            return { index, ok: false, reason: 'conflict', current: current.revision };
          }
          const patch = validateValuesWithContext(context, item.values, { requireAll: false });
          validateValuesWithContext(context, { ...current.values, ...patch }, { requireAll: true });
          return { index, ok: true };
        } catch (error) {
          return {
            index,
            ok: false,
            reason: 'invalid',
            message: error instanceof Error ? error.message : 'Invalid record',
          };
        }
      });
    },

    async batchUpsertRecords(input: {
      table_id: number;
      items: BatchUpsertTableRecordItem[];
      user_id: string;
    }): Promise<
      Array<
        | { index: number; ok: true; record: TableRecordRow }
        | { index: number; ok: false; reason: 'not_found' | 'conflict' | 'invalid'; message?: string; current?: number }
      >
    > {
      if (input.items.length < 1 || input.items.length > MAX_BATCH_RECORDS) {
        throw new TablesValidationError(`batch supports 1-${MAX_BATCH_RECORDS} records`);
      }
      const context = await loadValidationContext(input.table_id);
      const results = [];
      for (const [index, item] of input.items.entries()) {
        try {
          if (item.record_id == null) {
            const record = await createRecordWithContext(
              {
                table_id: input.table_id,
                values: item.values,
                user_id: input.user_id,
              },
              context,
            );
            await runAutomations('record_created', record);
            results.push({ index, ok: true as const, record });
            continue;
          }
          if (!item.revision) {
            results.push({ index, ok: false as const, reason: 'invalid' as const, message: 'revision is required' });
            continue;
          }
          const result = await updateRecordWithContext(
            {
              table_id: input.table_id,
              record_id: item.record_id,
              revision: item.revision,
              values: item.values,
              user_id: input.user_id,
            },
            context,
          );
          if (result.ok) await runAutomations('record_updated', result.record);
          results.push(result.ok ? { index, ok: true as const, record: result.record } : { index, ...result });
        } catch (error) {
          results.push({
            index,
            ok: false as const,
            reason: 'invalid' as const,
            message: error instanceof Error ? error.message : 'Invalid record',
          });
        }
      }
      return results;
    },

    async createDashboard(input: CreateTableDashboardInput): Promise<TableDashboardRow> {
      const now = nowIso();
      const [row] = await db
        .insert(tableDashboards)
        .values({
          base_id: input.base_id,
          name: trimmed(input.name, 'Dashboard name', 120),
          description: input.description?.trim() || null,
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async listDashboards(baseId: number): Promise<TableDashboardRow[]> {
      return db
        .select()
        .from(tableDashboards)
        .where(eq(tableDashboards.base_id, baseId))
        .orderBy(asc(tableDashboards.id));
    },

    async getDashboard(id: number): Promise<TableDashboardResult | undefined> {
      const rows = await db.select().from(tableDashboards).where(eq(tableDashboards.id, id)).limit(1);
      if (!rows[0]) return undefined;
      const widgets = await db
        .select()
        .from(tableDashboardWidgets)
        .where(eq(tableDashboardWidgets.dashboard_id, id))
        .orderBy(asc(tableDashboardWidgets.position), asc(tableDashboardWidgets.id));
      return { dashboard: rows[0], widgets };
    },

    async updateDashboard(
      id: number,
      patch: UpdateTableDashboardInput,
    ): Promise<TableRevisionResult<TableDashboardRow>> {
      const current = await db.select().from(tableDashboards).where(eq(tableDashboards.id, id)).limit(1);
      if (!current[0]) return { ok: false, reason: 'not_found' };
      if (current[0].revision !== patch.revision) {
        return { ok: false, reason: 'conflict', current: current[0].revision };
      }
      const values: Partial<TableDashboardRow> = {
        revision: patch.revision + 1,
        updated_at: nowIso(),
      };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'Dashboard name', 120);
      if (patch.description !== undefined) values.description = patch.description?.trim() || null;
      const rows = await db
        .update(tableDashboards)
        .set(values)
        .where(and(eq(tableDashboards.id, id), eq(tableDashboards.revision, patch.revision)))
        .returning();
      if (rows[0]) return { ok: true, value: rows[0] };
      const latest = await db.select().from(tableDashboards).where(eq(tableDashboards.id, id)).limit(1);
      return latest[0]
        ? { ok: false, reason: 'conflict', current: latest[0].revision }
        : { ok: false, reason: 'not_found' };
    },

    /**
     * Dashboards are pure configuration — widgets cascade and no business data
     * lives here — so this is a real delete rather than the archive used for
     * bases, tables and records (spec D4).
     */
    async deleteDashboard(id: number): Promise<boolean> {
      const rows = await db.delete(tableDashboards).where(eq(tableDashboards.id, id)).returning();
      return rows.length > 0;
    },

    async getDashboardWidget(id: number): Promise<TableDashboardWidgetRow | undefined> {
      const rows = await db.select().from(tableDashboardWidgets).where(eq(tableDashboardWidgets.id, id)).limit(1);
      return rows[0];
    },

    async createDashboardWidget(input: CreateTableDashboardWidgetInput): Promise<TableDashboardWidgetRow> {
      validateWidgetType(input.type);
      if (input.type !== 'text' && !input.table_id) {
        throw new TablesValidationError(`${input.type} widgets require table_id`);
      }
      const config = normalizeWidgetConfig(input.type, input.config);
      const layout = normalizeWidgetLayout(input.layout);
      const now = nowIso();
      const [row] = await db
        .insert(tableDashboardWidgets)
        .values({
          dashboard_id: input.dashboard_id,
          table_id: input.table_id ?? null,
          type: input.type,
          title: trimmed(input.title, 'Widget title', 120),
          config: JSON.stringify(config),
          layout: JSON.stringify(layout),
          position: input.position ?? 0,
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async updateDashboardWidget(
      id: number,
      patch: UpdateTableDashboardWidgetInput,
    ): Promise<TableRevisionResult<TableDashboardWidgetRow>> {
      const current = await service.getDashboardWidget(id);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.revision !== patch.revision) {
        return { ok: false, reason: 'conflict', current: current.revision };
      }
      const values: Partial<TableDashboardWidgetRow> = {
        revision: patch.revision + 1,
        updated_at: nowIso(),
      };
      if (patch.table_id !== undefined) values.table_id = patch.table_id;
      if (patch.title !== undefined) values.title = trimmed(patch.title, 'Widget title', 120);
      if (patch.config !== undefined) values.config = JSON.stringify(normalizeWidgetConfig(current.type, patch.config));
      if (patch.layout !== undefined) values.layout = JSON.stringify(normalizeWidgetLayout(patch.layout));
      if (patch.position !== undefined) values.position = patch.position;
      const rows = await db
        .update(tableDashboardWidgets)
        .set(values)
        .where(and(eq(tableDashboardWidgets.id, id), eq(tableDashboardWidgets.revision, patch.revision)))
        .returning();
      if (rows[0]) return { ok: true, value: rows[0] };
      const latest = await service.getDashboardWidget(id);
      return latest ? { ok: false, reason: 'conflict', current: latest.revision } : { ok: false, reason: 'not_found' };
    },

    async deleteDashboardWidget(id: number): Promise<boolean> {
      const rows = await db
        .delete(tableDashboardWidgets)
        .where(eq(tableDashboardWidgets.id, id))
        .returning({ id: tableDashboardWidgets.id });
      return rows.length > 0;
    },

    async aggregateRecords(tableId: number, input: TableAggregateInput): Promise<TableAggregateRow[]> {
      if (!TABLE_AGGREGATIONS.includes(input.operation)) {
        throw new TablesValidationError(`Unsupported aggregation "${input.operation}"`);
      }
      const query: TableQuery = { ...(input.query ?? {}), limit: 1 };
      const parts = await service.recordQueryParts(tableId, query);
      const fields = await service.listFields(tableId);
      const byId = new Map(fields.map((field) => [field.id, field]));
      if (input.operation !== 'count') {
        const valueField = input.valueFieldId ? byId.get(input.valueFieldId) : undefined;
        if (!valueField || queryValueField(valueField).type !== 'number') {
          throw new TablesValidationError(`${input.operation} requires a numeric valueFieldId`);
        }
      }
      const groupField = input.groupByFieldId ? byId.get(input.groupByFieldId) : undefined;
      if (input.groupByFieldId && !groupField) {
        throw new TablesValidationError('groupByFieldId is unavailable');
      }
      const groupExpr = groupField ? recordFieldText(String(groupField.id)) : sql<string | null>`NULL`;
      const valueField = input.valueFieldId ? byId.get(input.valueFieldId) : undefined;
      const numberExpr = valueField ? sql`NULLIF(${recordFieldText(String(valueField.id))}, '')::numeric` : sql`1`;
      let aggregate: SQL<number>;
      if (input.operation === 'sum') aggregate = sql<number>`coalesce(sum(${numberExpr}), 0)`;
      else if (input.operation === 'avg') aggregate = sql<number>`coalesce(avg(${numberExpr}), 0)`;
      else if (input.operation === 'min') aggregate = sql<number>`coalesce(min(${numberExpr}), 0)`;
      else if (input.operation === 'max') aggregate = sql<number>`coalesce(max(${numberExpr}), 0)`;
      else aggregate = sql<number>`count(*)`;

      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
      const rows = groupField
        ? await db
            .select({ group: groupExpr, value: aggregate })
            .from(tableRecords)
            .where(parts.where)
            // PostgreSQL treats separately-bound JSON path parameters in SELECT
            // and GROUP BY as distinct expressions. Grouping by the first
            // projected column keeps the validated expression single-sourced.
            .groupBy(sql.raw('1'))
            .orderBy(desc(aggregate))
            .limit(limit)
        : await db.select({ group: groupExpr, value: aggregate }).from(tableRecords).where(parts.where);
      return rows.map((row) => {
        const group =
          row.group === null ||
          typeof row.group === 'string' ||
          typeof row.group === 'number' ||
          typeof row.group === 'boolean'
            ? row.group
            : String(row.group);
        return { group, value: Number(row.value) };
      });
    },
  };

  return service;
}
