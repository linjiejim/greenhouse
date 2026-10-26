import { assertDiscriminator } from '@greenhouse/types/discriminators';
import { activitySql, type RecentWindow } from '@greenhouse/api/extension-kit';
const { ISO, inList, cursorClause, bound } = activitySql;
/**
 * Tables domain service — fixed-schema metadata, validated dynamic records,
 * bounded query AST, optimistic concurrency, and record aggregation.
 */

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { nowIso } from '@greenhouse/api/extension-kit';
import { isRowId, toRowId } from '@greenhouse/api/extension-kit';
import {
  TABLE_AGGREGATIONS,
  TABLE_FIELD_TYPES,
  TABLE_FILTER_OPERATORS,
  TABLE_FORMULA_BINARY_OPERATORS,
  TABLE_FORMULA_FUNCTIONS,
} from '@greenhouse/types/tables';
import type {
  TableAggregateInput,
  TableAggregateRow,
  TableBaseRole,
  TableBaseVisibility,
  TableBatchValidationResult,
  TableFieldConfig,
  TableFieldType,
  TableFilterClause,
  TableFormulaExpression,
  TableQuery,
  TableRecordValues,
  TableSchemaChangeType,
  TableSchemaSnapshot,
  TableViewConfig,
  TableViewScope,
} from '@greenhouse/types/tables';
import type { Db } from '@greenhouse/api/extension-kit';
import { newId } from '@greenhouse/api/extension-kit';
import { fileLinks, files, shares, users, type FileLinkRow, type ShareRow } from '@greenhouse/api/extension-kit';
import {
  tableBases,
  tableFieldDependencies,
  tableFields,
  tableRecordLinks,
  tableRecords,
  tableRecomputeJobs,
  tableSchemaVersions,
  tableTables,
  tableViews,
} from './schema.js';
import type {
  TableBaseRow,
  TableDefinitionRow,
  TableFieldDependencyRow,
  TableFieldRow,
  TableRecomputeJobRow,
  TableRecordLinkRow,
  TableRecordRow,
  TableSchemaVersionRow,
  TableViewRow,
} from './schema.js';

/** A Base member: a `shares` row with resource_type = 'table_base' and a user principal. */
export interface TableBaseMemberRow {
  id: string;
  base_id: string;
  user_id: string;
  role: TableBaseRole;
  added_by: string;
  created_at: string;
  updated_at: string;
}

/** A file in a record's attachment field: a `file_links` row (target_type = 'table_record', slot = field id). */
export interface TableRecordAttachmentRow {
  record_id: string;
  field_id: string;
  drive_file_id: string;
  position: number;
  created_by: string;
  created_at: string;
}

const BASE_SHARE = 'table_base' as const;
const RECORD_LINK_TARGET = 'table_record' as const;

function memberFromShare(row: ShareRow): TableBaseMemberRow {
  return {
    id: row.id,
    base_id: row.resource_id,
    user_id: row.principal_id ?? '',
    role: row.role as TableBaseRole,
    added_by: row.created_by ?? '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function attachmentFromLink(row: FileLinkRow): TableRecordAttachmentRow {
  return {
    record_id: row.target_id,
    field_id: row.slot,
    drive_file_id: row.file_id,
    position: row.position,
    created_by: row.created_by ?? '',
    created_at: row.created_at,
  };
}

/** Members are user-principal shares on the Base. */
function baseMemberWhere(baseId: string, userId?: string): SQL {
  return and(
    eq(shares.resource_type, BASE_SHARE),
    eq(shares.resource_id, baseId),
    eq(shares.principal_type, 'user'),
    ...(userId === undefined ? [] : [eq(shares.principal_id, userId)]),
  )!;
}

type TablesTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

const MAX_FIELDS = 100;
const MAX_QUERY_CLAUSES = 20;
const MAX_QUERY_SORTS = 3;
const MAX_QUERY_LIMIT = 500;
const MAX_BATCH_RECORDS = 100;

/** Ids are opaque strings (carried 1.x rows keep "42"), so ties break on creation time, never on id order alone. */
const FIELD_ORDER = [asc(tableFields.position), asc(tableFields.created_at), asc(tableFields.id)];

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
  base_id: string;
  name: string;
  description?: string | null;
  created_by: string;
}

export interface CreateTableFieldInput {
  table_id: string;
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
  table_id: string;
  name: string;
  scope?: TableViewScope;
  owner_id?: string | null;
  config?: TableViewConfig;
  position?: number;
  created_by: string;
}

export interface CreateTableRecordInput {
  table_id: string;
  values: TableRecordValues;
  user_id: string;
}

export interface UpdateTableRecordInput {
  table_id: string;
  record_id: string;
  revision: number;
  values: TableRecordValues;
  user_id: string;
}

export interface BatchUpsertTableRecordItem {
  record_id?: string;
  revision?: number;
  values: TableRecordValues;
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

function trimmed(value: string, field: string, max: number): string {
  const result = value.trim();
  if (!result) throw new TablesValidationError(`${field} is required`);
  if (result.length > max) throw new TablesValidationError(`${field} exceeds ${max} characters`);
  return result;
}

/** A well-formed id, or a legacy numeric id normalized to its string form; undefined otherwise. */
function idOf(value: unknown): string | undefined {
  return toRowId(value) ?? undefined;
}

/** Record ids held in a relation value (single or multiple); legacy numbers become strings. */
function relationIds(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return entries.map(idOf).filter((entry): entry is string => entry !== undefined);
}

function validateFieldType(type: TableFieldType): void {
  if (!TABLE_FIELD_TYPES.includes(type)) throw new TablesValidationError(`Unsupported field type "${type}"`);
}

/** Validates a query's shape and returns it with field ids normalized to strings (legacy numbers accepted). */
function normalizeQueryShape(query: TableQuery): TableQuery {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new TablesValidationError('query must be an object');
  }
  if (query.search !== undefined && typeof query.search !== 'string') {
    throw new TablesValidationError('search must be text');
  }
  if (query.cursor !== undefined && typeof query.cursor !== 'string') {
    throw new TablesValidationError('cursor must be text');
  }
  if (query.recordIds !== undefined) {
    if (
      !Array.isArray(query.recordIds) ||
      query.recordIds.length > MAX_QUERY_LIMIT ||
      !query.recordIds.every((id) => idOf(id) !== undefined)
    ) {
      throw new TablesValidationError(`recordIds must be a list of at most ${MAX_QUERY_LIMIT} record ids`);
    }
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
        !idOf(clause.fieldId) ||
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
        (sort.fieldId !== undefined && !idOf(sort.fieldId)) ||
        (sort.systemField !== undefined && sort.systemField !== 'created_at' && sort.systemField !== 'updated_at') ||
        (sort.fieldId === undefined && sort.systemField === undefined) ||
        (sort.fieldId !== undefined && sort.systemField !== undefined)
      ) {
        throw new TablesValidationError('Each sort requires one valid field and asc/desc direction');
      }
    }
  }
  return {
    ...query,
    ...(query.recordIds ? { recordIds: query.recordIds.map((id) => idOf(id)!) } : {}),
    ...(query.where
      ? {
          where: {
            ...query.where,
            clauses: query.where.clauses.map((clause) => ({ ...clause, fieldId: idOf(clause.fieldId)! })),
          },
        }
      : {}),
    ...(query.sort
      ? {
          sort: query.sort.map((sort) =>
            sort.fieldId === undefined ? sort : { ...sort, fieldId: idOf(sort.fieldId)! },
          ),
        }
      : {}),
  };
}

/** View config as stored: version 1, column ids as strings (legacy numbers accepted). */
function normalizeViewConfig(config: TableViewConfig | undefined): TableViewConfig {
  const next: TableViewConfig = { ...(config ?? {}), version: 1 };
  if (Array.isArray(config?.fieldIds)) {
    next.fieldIds = config.fieldIds.map(idOf).filter((entry): entry is string => entry !== undefined);
  }
  if (config?.query) next.query = normalizeQueryShape(config.query);
  return next;
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

function readFormulaIds(expression: TableFormulaExpression): TableFormulaExpression {
  if (!expression || typeof expression !== 'object') return expression;
  if (expression.type === 'field') return { ...expression, fieldId: idOf(expression.fieldId) ?? '' };
  if (expression.type === 'binary') {
    return { ...expression, left: readFormulaIds(expression.left), right: readFormulaIds(expression.right) };
  }
  if (expression.type === 'function' && Array.isArray(expression.args)) {
    return { ...expression, args: expression.args.map(readFormulaIds) };
  }
  return expression;
}

/**
 * A field's stored config with every id it holds as a string: configs written
 * before ids became text (carried 1.x rows) may still hold numbers.
 */
export function parseTableFieldConfig(field: Pick<TableFieldRow, 'config'>): TableFieldConfig {
  const raw = field.config as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const config = raw as TableFieldConfig;
  if (!config.relation && !config.rollup && !config.formula) return config;
  const next: TableFieldConfig = { ...config };
  if (config.relation) {
    next.relation = { ...config.relation, targetTableId: idOf(config.relation.targetTableId) ?? '' };
  }
  if (config.rollup) {
    next.rollup = {
      ...config.rollup,
      relationFieldId: idOf(config.rollup.relationFieldId) ?? '',
      targetFieldId: idOf(config.rollup.targetFieldId) ?? '',
    };
  }
  if (config.formula) next.formula = { ...config.formula, expression: readFormulaIds(config.formula.expression) };
  return next;
}

function buildSchemaSnapshot(tableId: string, fields: TableFieldRow[]): TableSchemaSnapshot {
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
    const fieldId = idOf(expression.fieldId);
    if (!fieldId) throw new TablesValidationError('Formula fieldId is invalid');
    return { type: 'field', fieldId };
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

function formulaFieldIds(expression: TableFormulaExpression, result = new Set<string>()): Set<string> {
  if (expression.type === 'field') {
    const fieldId = idOf(expression.fieldId);
    if (fieldId) result.add(fieldId);
  } else if (expression.type === 'binary') {
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
    const targetTableId = idOf(config.relation?.targetTableId);
    if (!targetTableId) {
      throw new TablesValidationError('Relation fields require targetTableId');
    }
    return {
      version: 1,
      relation: {
        targetTableId,
        multiple: config.relation?.multiple === true,
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
    const relationFieldId = idOf(rollup?.relationFieldId);
    const targetFieldId = idOf(rollup?.targetFieldId);
    if (
      !rollup ||
      !relationFieldId ||
      !targetFieldId ||
      !['count', 'sum', 'avg', 'min', 'max', 'join'].includes(rollup.aggregation)
    ) {
      throw new TablesValidationError('Rollup fields require relationFieldId, targetFieldId, and aggregation');
    }
    return { version: 1, rollup: { relationFieldId, targetFieldId, aggregation: rollup.aggregation } };
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
      const ids = value.map(idOf);
      return ids.every((entry): entry is string => entry !== undefined) ? [...new Set(ids)] : invalid('Drive file ids');
    }
    case 'relation': {
      const multiple = config.relation?.multiple === true;
      if (multiple) {
        if (!Array.isArray(value) || value.length > 500) return invalid('record ids');
        const ids = value.map(idOf);
        return ids.every((entry): entry is string => entry !== undefined) ? [...new Set(ids)] : invalid('record ids');
      }
      return idOf(value) ?? invalid('a record id');
    }
    case 'formula':
    case 'rollup':
      return invalid('a computed value');
  }
}

function queryFingerprint(tableId: string, query: TableQuery): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        tableId,
        where: query.where ?? null,
        recordIds: query.recordIds ?? null,
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
  relationTargets: Map<string, Set<string>>;
  attachmentFileIds: Set<string>;
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
    if (!isRowId(key)) throw new TablesValidationError(`Invalid field id "${key}"`);
    const field = context.byId.get(key);
    if (!field) throw new TablesValidationError(`Field ${key} is unavailable`);
    if (field.type === 'formula' || field.type === 'rollup') {
      throw new TablesValidationError(`Field "${field.name}" is computed and cannot be written`);
    }
    const nextValue = validateTableFieldValue(field, value, context.activeUserIds);
    if (field.type === 'relation' && nextValue !== null) {
      const validIds = context.relationTargets.get(key) ?? new Set<string>();
      const ids = relationIds(nextValue);
      if (ids.some((id) => !validIds.has(id))) {
        throw new TablesValidationError(`Field "${field.name}" references an unavailable record`);
      }
    }
    if (field.type === 'attachment' && Array.isArray(nextValue)) {
      if ((nextValue as string[]).some((id) => !context.attachmentFileIds.has(id))) {
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

export function createTablesService(db: Db) {
  const loadValidationContext = async (tableId: string): Promise<TableValidationContext> => {
    const fields = await db
      .select()
      .from(tableFields)
      .where(and(eq(tableFields.table_id, tableId), isNull(tableFields.archived_at)))
      .orderBy(...FIELD_ORDER);
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
      .map((field) => ({ field, targetTableId: idOf(parseTableFieldConfig(field).relation?.targetTableId) }))
      .filter((entry): entry is { field: TableFieldRow; targetTableId: string } => entry.targetTableId !== undefined);
    const targetTableIds = [...new Set(relationFields.map((entry) => entry.targetTableId))];
    const targetRows =
      targetTableIds.length === 0
        ? []
        : await db
            .select({ id: tableRecords.id, table_id: tableRecords.table_id })
            .from(tableRecords)
            .where(and(inArray(tableRecords.table_id, targetTableIds), isNull(tableRecords.deleted_at)));
    const idsByTable = new Map<string, Set<string>>();
    for (const record of targetRows) {
      const ids = idsByTable.get(record.table_id) ?? new Set<string>();
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
                .select({ id: files.id })
                .from(files)
                .where(
                  and(
                    eq(files.source, 'drive'),
                    eq(files.scope, 'tables'),
                    eq(files.base_id, table.base_id),
                    eq(files.status, 'active'),
                  ),
                )
            ).map((file) => file.id),
          )
        : new Set<string>();
    return {
      fields,
      byId: new Map(fields.map((field) => [String(field.id), field])),
      activeUserIds,
      relationTargets: new Map(
        relationFields.map(({ field, targetTableId }) => [
          String(field.id),
          idsByTable.get(targetTableId) ?? new Set<string>(),
        ]),
      ),
      attachmentFileIds,
    };
  };

  const writeSchemaVersion = async (
    tx: TablesTransaction,
    tableId: string,
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
      .orderBy(...FIELD_ORDER);
    const nextVersion = table.schema_revision + 1;
    const now = nowIso();
    await tx
      .update(tableTables)
      .set({ schema_revision: nextVersion, updated_at: now })
      .where(eq(tableTables.id, tableId));
    await tx.insert(tableSchemaVersions).values({
      id: newId('schemaVersion'),
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
    recordId: string,
    values: TableRecordValues,
    fields: TableFieldRow[],
    userId: string,
  ): Promise<void> => {
    await tx.delete(tableRecordLinks).where(eq(tableRecordLinks.source_record_id, recordId));
    await tx
      .delete(fileLinks)
      .where(and(eq(fileLinks.target_type, RECORD_LINK_TARGET), eq(fileLinks.target_id, recordId)));
    const now = nowIso();
    const links: Array<typeof tableRecordLinks.$inferInsert> = [];
    const attachments: Array<typeof fileLinks.$inferInsert> = [];
    for (const field of fields) {
      const value = values[String(field.id)];
      if (field.type === 'relation') {
        relationIds(value).forEach((targetRecordId, position) => {
          links.push({
            id: newId('recordLink'),
            field_id: field.id,
            source_record_id: recordId,
            target_record_id: targetRecordId,
            position,
            created_by: userId,
            created_at: now,
          });
        });
      } else if (field.type === 'attachment' && Array.isArray(value)) {
        relationIds(value).forEach((fileId, position) => {
          attachments.push({
            file_id: fileId,
            target_type: RECORD_LINK_TARGET,
            target_id: recordId,
            slot: field.id,
            position,
            created_by: userId,
            created_at: now,
          });
        });
      }
    }
    if (links.length > 0) await tx.insert(tableRecordLinks).values(links);
    if (attachments.length > 0) {
      assertDiscriminator('fileLinkTargets', RECORD_LINK_TARGET);
      await tx.insert(fileLinks).values(attachments).onConflictDoNothing();
    }
  };

  const validateModelConfig = async (
    tableId: string,
    type: TableFieldType,
    config: TableFieldConfig,
    fieldId?: string,
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

  const computeRecordValues = async (tableId: string, values: TableRecordValues): Promise<TableRecordValues> => {
    const fields = await db
      .select()
      .from(tableFields)
      .where(and(eq(tableFields.table_id, tableId), isNull(tableFields.archived_at)))
      .orderBy(...FIELD_ORDER);
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
        const recordIds = relationIds(relationValue);
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

  const recomputeTable = async (tableId: string): Promise<void> => {
    const records = await db
      .select()
      .from(tableRecords)
      .where(and(eq(tableRecords.table_id, tableId), isNull(tableRecords.deleted_at)));
    for (const record of records) await recomputeRecord(record);
  };

  const refreshDependentRollups = async (targetTableId: string, targetRecordId: string): Promise<void> => {
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
      if (!relationField || idOf(parseTableFieldConfig(relationField).relation?.targetTableId) !== targetTableId) {
        continue;
      }
      const records = await db
        .select()
        .from(tableRecords)
        .where(and(eq(tableRecords.table_id, rollupField.table_id), isNull(tableRecords.deleted_at)));
      for (const record of records) {
        if (relationIds(record.values[String(relationField.id)]).includes(targetRecordId)) {
          const now = nowIso();
          const [job] = await db
            .insert(tableRecomputeJobs)
            .values({
              id: newId('recomputeJob'),
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
          id: newId('record'),
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

  const service = {
    /**
     * Record changes in the given (already authorized) tables, one row per
     * (table, person) with how many records they touched in the whole window —
     * record values are never read. Groups are formed before paging, so a
     * group is one row ordered by its latest change and never split across
     * pages.
     */
    async recentTableChanges(input: RecentWindow & { tableIds: readonly string[] }): Promise<RecentTableChangeRow[]> {
      if (input.tableIds.length === 0) return [];
      const rows = await db.execute(sql`
        SELECT key, table_id, updated_by, records, ${ISO(sql`latest`)} AS at
        FROM (
          SELECT ('tr:' || r.table_id || ':' || r.updated_by) AS key, r.table_id, r.updated_by,
                 count(*)::int AS records, max(r.updated_at) AS latest
          FROM table_records r
          WHERE ${inList(sql`r.table_id`, input.tableIds)}
            AND r.updated_at >= ${input.since}::timestamptz
            AND r.deleted_at IS NULL
          GROUP BY r.table_id, r.updated_by
        ) g
        WHERE ${cursorClause(sql`latest`, sql`key`, input.cursor)}
        ORDER BY latest DESC, key COLLATE "C" DESC
        LIMIT ${bound(input.limit)}
      `);
      return (rows as unknown as RecentTableChangeRow[]).map((row) => ({ ...row, records: Number(row.records) }));
    },

    async activeInternalUserIds(): Promise<Set<string>> {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.status, 'active'), inArray(users.role, ['team', 'super'])));
      return new Set(rows.map((row) => row.id));
    },

    async getBase(id: string): Promise<TableBaseRow | undefined> {
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
            SELECT 1 FROM ${shares}
            WHERE ${shares.resource_type} = ${BASE_SHARE}
              AND ${shares.resource_id} = ${tableBases.id}
              AND ${shares.principal_type} = 'user'
              AND ${shares.principal_id} = ${userId}
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
      assertDiscriminator('shareResources', BASE_SHARE);
      const now = nowIso();
      return db.transaction(async (tx) => {
        const [base] = await tx
          .insert(tableBases)
          .values({
            id: newId('base'),
            name: trimmed(input.name, 'Base name', 120),
            description: input.description?.trim() || null,
            visibility: input.visibility ?? 'private',
            owner_id: input.owner_id,
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
          })
          .returning();
        await tx.insert(shares).values({
          id: newId('share'),
          resource_type: BASE_SHARE,
          resource_id: base!.id,
          principal_type: 'user',
          principal_id: input.owner_id,
          role: 'owner',
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        });
        return base!;
      });
    },

    async updateBase(id: string, patch: UpdateTableBaseInput): Promise<TableBaseRow | undefined> {
      const values: Partial<TableBaseRow> = { updated_at: nowIso() };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'Base name', 120);
      if (patch.description !== undefined) values.description = patch.description?.trim() || null;
      if (patch.visibility !== undefined) values.visibility = patch.visibility;
      const rows = await db.update(tableBases).set(values).where(eq(tableBases.id, id)).returning();
      return rows[0];
    },

    async archiveBase(id: string): Promise<TableBaseRow | undefined> {
      const now = nowIso();
      const rows = await db
        .update(tableBases)
        .set({ archived_at: now, updated_at: now })
        .where(and(eq(tableBases.id, id), isNull(tableBases.archived_at)))
        .returning();
      return rows[0];
    },

    async restoreBase(id: string): Promise<TableBaseRow | undefined> {
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

    async getBaseMember(baseId: string, userId: string): Promise<TableBaseMemberRow | undefined> {
      const rows = await db.select().from(shares).where(baseMemberWhere(baseId, userId)).limit(1);
      return rows[0] ? memberFromShare(rows[0]) : undefined;
    },

    async listBaseMembers(baseId: string): Promise<TableBaseMemberRow[]> {
      const rows = await db
        .select()
        .from(shares)
        .where(baseMemberWhere(baseId))
        .orderBy(asc(shares.created_at), asc(shares.id));
      return rows.map(memberFromShare);
    },

    async upsertBaseMember(input: {
      base_id: string;
      user_id: string;
      role: TableBaseRole;
      added_by: string;
    }): Promise<TableBaseMemberRow> {
      assertDiscriminator('shareResources', BASE_SHARE);
      const now = nowIso();
      const [row] = await db
        .insert(shares)
        .values({
          id: newId('share'),
          resource_type: BASE_SHARE,
          resource_id: input.base_id,
          principal_type: 'user',
          principal_id: input.user_id,
          role: input.role,
          created_by: input.added_by,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [shares.resource_type, shares.resource_id, shares.principal_type, shares.principal_id],
          set: { role: input.role, created_by: input.added_by, updated_at: now },
        })
        .returning();
      return memberFromShare(row!);
    },

    async removeBaseMember(baseId: string, userId: string): Promise<boolean> {
      const rows = await db.delete(shares).where(baseMemberWhere(baseId, userId)).returning({ id: shares.id });
      return rows.length > 0;
    },

    async getTable(id: string): Promise<TableDefinitionRow | undefined> {
      const rows = await db.select().from(tableTables).where(eq(tableTables.id, id)).limit(1);
      return rows[0];
    },

    async listTables(baseId: string): Promise<TableDefinitionRow[]> {
      return db
        .select()
        .from(tableTables)
        .where(and(eq(tableTables.base_id, baseId), isNull(tableTables.archived_at)))
        .orderBy(asc(tableTables.position), asc(tableTables.created_at), asc(tableTables.id));
    },

    /**
     * Live row count and latest record change per table — counts only, never
     * a record value (the data catalog). Tables without records are absent.
     */
    async recordStats(
      tableIds: readonly string[],
    ): Promise<Array<{ table_id: string; row_count: number; last_changed_at: string | null }>> {
      if (tableIds.length === 0) return [];
      const rows = await db
        .select({
          table_id: tableRecords.table_id,
          row_count: sql<string>`count(*)`,
          last_changed_at: sql<string | null>`max(${tableRecords.updated_at})`,
        })
        .from(tableRecords)
        .where(and(inArray(tableRecords.table_id, [...tableIds]), isNull(tableRecords.deleted_at)))
        .groupBy(tableRecords.table_id);
      return rows.map((row) => ({
        table_id: row.table_id,
        row_count: Number(row.row_count),
        last_changed_at: row.last_changed_at ? new Date(row.last_changed_at).toISOString() : null,
      }));
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
            id: newId('baseTable'),
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
            id: newId('field'),
            table_id: table!.id,
            name: 'Name',
            type: 'text',
            required: true,
            is_primary: true,
            config: { version: 1 } satisfies TableFieldConfig,
            position: 0,
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
          })
          .returning();
        const [view] = await tx
          .insert(tableViews)
          .values({
            id: newId('view'),
            table_id: table!.id,
            name: 'Grid',
            type: 'grid',
            scope: 'shared',
            config: { version: 1, fieldIds: [field!.id] } satisfies TableViewConfig,
            position: 0,
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
          })
          .returning();
        await tx.insert(tableSchemaVersions).values({
          id: newId('schemaVersion'),
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
      id: string,
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
    async archiveTable(id: string): Promise<TableDefinitionRow | undefined> {
      const now = nowIso();
      const rows = await db
        .update(tableTables)
        .set({ archived_at: now, updated_at: now })
        .where(and(eq(tableTables.id, id), isNull(tableTables.archived_at)))
        .returning();
      return rows[0];
    },

    async restoreTable(id: string): Promise<TableDefinitionRow | undefined> {
      const rows = await db
        .update(tableTables)
        .set({ archived_at: null, updated_at: nowIso() })
        .where(eq(tableTables.id, id))
        .returning();
      return rows[0];
    },

    async listArchivedTables(baseId?: string): Promise<TableDefinitionRow[]> {
      const conditions: SQL[] = [isNotNull(tableTables.archived_at)];
      if (baseId !== undefined) conditions.push(eq(tableTables.base_id, baseId));
      return db
        .select()
        .from(tableTables)
        .where(and(...conditions))
        .orderBy(desc(tableTables.archived_at));
    },

    async getField(id: string): Promise<TableFieldRow | undefined> {
      const rows = await db.select().from(tableFields).where(eq(tableFields.id, id)).limit(1);
      return rows[0];
    },

    async listSchemaVersions(tableId: string): Promise<TableSchemaVersionRow[]> {
      return db
        .select()
        .from(tableSchemaVersions)
        .where(eq(tableSchemaVersions.table_id, tableId))
        .orderBy(desc(tableSchemaVersions.version));
    },

    async getSchemaVersion(tableId: string, version: number): Promise<TableSchemaVersionRow | undefined> {
      const rows = await db
        .select()
        .from(tableSchemaVersions)
        .where(and(eq(tableSchemaVersions.table_id, tableId), eq(tableSchemaVersions.version, version)))
        .limit(1);
      return rows[0];
    },

    async listFields(tableId: string, includeArchived = false): Promise<TableFieldRow[]> {
      const conditions = [eq(tableFields.table_id, tableId)];
      if (!includeArchived) conditions.push(isNull(tableFields.archived_at));
      return db
        .select()
        .from(tableFields)
        .where(and(...conditions))
        .orderBy(...FIELD_ORDER);
    },

    async listFieldDependencies(fieldId: string): Promise<TableFieldDependencyRow[]> {
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
          .orderBy(...FIELD_ORDER);
        if (current.length >= MAX_FIELDS) {
          throw new TablesValidationError(`A table supports at most ${MAX_FIELDS} fields`);
        }
        const nextPosition = input.position ?? (current.at(-1)?.position ?? -1) + 1;
        const [row] = await tx
          .insert(tableFields)
          .values({
            id: newId('field'),
            table_id: input.table_id,
            name: trimmed(input.name, 'Field name', 120),
            type: input.type,
            required: input.required ?? false,
            config,
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

    async updateField(id: string, patch: UpdateTableFieldInput): Promise<TableFieldRow | undefined> {
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
        if (normalizedConfig !== undefined) values.config = normalizedConfig;
        if (patch.position !== undefined) values.position = patch.position;
        const rows = await tx.update(tableFields).set(values).where(eq(tableFields.id, id)).returning();
        await syncFieldDependencies(tx, rows[0]!, normalizedConfig ?? parseTableFieldConfig(rows[0]!));
        await writeSchemaVersion(tx, field.table_id, 'field_updated', patch.updated_by);
        return rows[0];
      });
      if (row && (row.type === 'formula' || row.type === 'rollup')) await recomputeTable(row.table_id);
      return row;
    },

    async archiveField(id: string, userId: string): Promise<TableFieldRow | undefined> {
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

    async listViews(tableId: string, userId?: string): Promise<TableViewRow[]> {
      const visibility = userId
        ? or(eq(tableViews.scope, 'shared'), eq(tableViews.owner_id, userId))
        : eq(tableViews.scope, 'shared');
      return db
        .select()
        .from(tableViews)
        .where(and(eq(tableViews.table_id, tableId), visibility))
        .orderBy(asc(tableViews.position), asc(tableViews.created_at), asc(tableViews.id));
    },

    async getView(id: string, userId?: string): Promise<TableViewRow | undefined> {
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
          id: newId('view'),
          table_id: input.table_id,
          name: trimmed(input.name, 'View name', 120),
          type: 'grid',
          scope: input.scope ?? 'shared',
          owner_id: input.scope === 'personal' ? input.owner_id : null,
          config: normalizeViewConfig(input.config),
          position: input.position ?? 0,
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async updateView(
      id: string,
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
        values.config = normalizeViewConfig(patch.config);
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

    async getSchema(tableId: string, userId?: string): Promise<TableSchemaResult | undefined> {
      const table = await service.getTable(tableId);
      if (!table || table.archived_at) return undefined;
      const [fields, views] = await Promise.all([service.listFields(tableId), service.listViews(tableId, userId)]);
      return { table, fields, views };
    },

    async validatedValues(
      tableId: string,
      values: TableRecordValues,
      options: { requireAll: boolean },
    ): Promise<TableRecordValues> {
      return validateValuesWithContext(await loadValidationContext(tableId), values, options);
    },

    async createRecord(input: CreateTableRecordInput): Promise<TableRecordRow> {
      return createRecordWithContext(input, await loadValidationContext(input.table_id));
    },

    async getRecord(tableId: string, recordId: string): Promise<TableRecordRow | undefined> {
      const rows = await db
        .select()
        .from(tableRecords)
        .where(and(eq(tableRecords.table_id, tableId), eq(tableRecords.id, recordId), isNull(tableRecords.deleted_at)))
        .limit(1);
      return rows[0];
    },

    async getRecordById(recordId: string): Promise<TableRecordRow | undefined> {
      const rows = await db.select().from(tableRecords).where(eq(tableRecords.id, recordId)).limit(1);
      return rows[0];
    },

    async listRecordLinks(fieldId: string, sourceRecordId: string): Promise<TableRecordLinkRow[]> {
      return db
        .select()
        .from(tableRecordLinks)
        .where(and(eq(tableRecordLinks.field_id, fieldId), eq(tableRecordLinks.source_record_id, sourceRecordId)))
        .orderBy(asc(tableRecordLinks.position));
    },

    async listRecordAttachments(recordId: string, fieldId: string): Promise<TableRecordAttachmentRow[]> {
      const rows = await db
        .select()
        .from(fileLinks)
        .where(
          and(
            eq(fileLinks.target_type, RECORD_LINK_TARGET),
            eq(fileLinks.target_id, recordId),
            eq(fileLinks.slot, fieldId),
          ),
        )
        .orderBy(asc(fileLinks.position));
      return rows.map(attachmentFromLink);
    },

    async listRecomputeJobs(recordId: string): Promise<TableRecomputeJobRow[]> {
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
      return updateRecordWithContext(input, await loadValidationContext(input.table_id));
    },

    async deleteRecord(input: {
      table_id: string;
      record_id: string;
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
    async listDeletedRecords(tableId: string, limit = 100): Promise<TableRecordRow[]> {
      return db
        .select()
        .from(tableRecords)
        .where(and(eq(tableRecords.table_id, tableId), isNotNull(tableRecords.deleted_at)))
        .orderBy(desc(tableRecords.updated_at))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    async restoreRecord(input: {
      table_id: string;
      record_id: string;
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
      tableId: string,
      rawQuery: TableQuery,
    ): Promise<{
      where: SQL;
      order: SQL[];
      limit: number;
      offset: number;
      fingerprint: string;
    }> {
      const query = normalizeQueryShape(rawQuery);
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
      if (query.recordIds) {
        conditions.push(query.recordIds.length > 0 ? inArray(tableRecords.id, query.recordIds) : sql`false`);
      }

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
      order.push(asc(tableRecords.created_at), asc(tableRecords.id));
      const fingerprint = queryFingerprint(tableId, query);
      return {
        where: and(...conditions)!,
        order,
        limit,
        offset: decodeCursor(query.cursor, fingerprint),
        fingerprint,
      };
    },

    async queryRecords(tableId: string, query: TableQuery = {}): Promise<TableRecordQueryResult> {
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
      table_id: string;
      items: BatchUpsertTableRecordItem[];
    }): Promise<TableBatchValidationResult[]> {
      if (input.items.length < 1 || input.items.length > MAX_BATCH_RECORDS) {
        throw new TablesValidationError(`batch supports 1-${MAX_BATCH_RECORDS} records`);
      }
      const context = await loadValidationContext(input.table_id);
      const recordIds = [
        ...new Set(
          input.items
            .map((item) => idOf(item.record_id))
            .filter((recordId): recordId is string => recordId !== undefined),
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
          const current = byRecordId.get(idOf(item.record_id) ?? '');
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
      table_id: string;
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
              record_id: idOf(item.record_id) ?? String(item.record_id),
              revision: item.revision,
              values: item.values,
              user_id: input.user_id,
            },
            context,
          );
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

    async aggregateRecords(tableId: string, input: TableAggregateInput): Promise<TableAggregateRow[]> {
      if (!TABLE_AGGREGATIONS.includes(input.operation)) {
        throw new TablesValidationError(`Unsupported aggregation "${input.operation}"`);
      }
      const query: TableQuery = { ...(input.query ?? {}), limit: 1 };
      const parts = await service.recordQueryParts(tableId, query);
      const fields = await service.listFields(tableId);
      const byId = new Map(fields.map((field) => [field.id, field]));
      const valueFieldId = idOf(input.valueFieldId);
      const groupByFieldId = idOf(input.groupByFieldId);
      if (input.operation !== 'count') {
        const valueField = valueFieldId ? byId.get(valueFieldId) : undefined;
        if (!valueField || queryValueField(valueField).type !== 'number') {
          throw new TablesValidationError(`${input.operation} requires a numeric valueFieldId`);
        }
      }
      const groupField = groupByFieldId ? byId.get(groupByFieldId) : undefined;
      if (input.groupByFieldId && !groupField) {
        throw new TablesValidationError('groupByFieldId is unavailable');
      }
      const groupExpr = groupField ? recordFieldText(String(groupField.id)) : sql<string | null>`NULL`;
      const valueField = valueFieldId ? byId.get(valueFieldId) : undefined;
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

export interface RecentTableChangeRow {
  key: string;
  table_id: string;
  updated_by: string;
  records: number;
  at: string;
}
