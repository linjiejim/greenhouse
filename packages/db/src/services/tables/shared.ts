/**
 * Tables service internals shared by every domain module: the error type,
 * limits, field / value validation and small pure helpers.
 *
 * The SQL compiler lives next door in `./query.ts`; nothing here touches the
 * database.
 */

import { safeJsonParse } from '@greenhouse/utils/json';
import {
  isComputedFieldType,
  TABLE_FIELD_TYPES,
  TABLE_FORMULA_BINARY_OPERATORS,
  TABLE_FORMULA_FUNCTIONS,
  TABLE_RECORD_ACTOR_KINDS,
} from '@greenhouse/types/tables';
import type {
  TableFieldConfig,
  TableFieldType,
  TableFormulaExpression,
  TableRecordEventType,
  TableRecordValues,
  TableRecordWriteMeta,
  TableSchemaSnapshot,
} from '@greenhouse/types/tables';
import type { TableAccessScope } from '@greenhouse/types/table-access';
import {
  TABLE_FORMULA_FUNCTION_CATALOG,
  TABLE_FORMULA_MAX_ARGS,
  TABLE_FORMULA_MAX_DEPTH,
  TABLE_FORMULA_MAX_NODES,
} from '@greenhouse/types/table-formula';
import type { Db } from '../../client.js';
import type { TableFieldRow, TableRecordRow } from '../../schema/tables.js';

export type TablesTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The database or an open transaction — whatever the write is running on. */
export type TablesExecutor = Pick<Db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export const MAX_FIELDS = 100;
export const MAX_QUERY_CLAUSES = 20;
export const MAX_QUERY_SORTS = 3;
export const MAX_QUERY_FILTER_GROUPS = 5;
export const MAX_QUERY_LIMIT = 500;
export const MAX_BATCH_RECORDS = 100;

/**
 * Why a Tables call was refused. `invalid` / `field_not_readable` / `not_supported`
 * are bad input (INVALID_INPUT); the others are permission refusals the API maps
 * to FORBIDDEN (see `TABLES_FORBIDDEN_CODES`).
 */
export type TablesErrorCode =
  | 'invalid'
  | 'field_not_readable'
  | 'field_not_editable'
  | 'create_forbidden'
  | 'delete_forbidden'
  | 'not_supported';

export class TablesValidationError extends Error {
  readonly code: TablesErrorCode;

  constructor(message: string, code: TablesErrorCode = 'invalid') {
    super(message);
    this.name = 'TablesValidationError';
    this.code = code;
  }
}

/** Codes the API surfaces as 403 FORBIDDEN rather than 400 INVALID_INPUT. */
export const TABLES_FORBIDDEN_CODES: ReadonlySet<TablesErrorCode> = new Set<TablesErrorCode>([
  'field_not_editable',
  'create_forbidden',
  'delete_forbidden',
]);

export function isTablesForbiddenError(error: unknown): error is TablesValidationError {
  return error instanceof TablesValidationError && TABLES_FORBIDDEN_CODES.has(error.code);
}

export type TableRevisionResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' | 'conflict'; current?: number };

/**
 * What `onRecordWritten` receives. `before` / `after` are `values ∪ computed_values`
 * (null when the record did not exist / no longer exists for the reader).
 */
export interface TableRecordWrittenEvent {
  kind: TableRecordEventType;
  tableId: number;
  recordId: number;
  /** The record's revision after this write. */
  revision: number;
  before: TableRecordValues | null;
  after: TableRecordValues | null;
  meta: TableRecordWriteMeta;
  /**
   * Updates only: the row's `updated_at` / `updated_by` before this write, so a
   * condition on those system fields can be evaluated against the before image
   * (`record_matched`).
   */
  previous?: { updatedAt: string; updatedBy: string };
}

export function trimmed(value: string, field: string, max: number): string {
  if (typeof value !== 'string') throw new TablesValidationError(`${field} is required`);
  const result = value.trim();
  if (!result) throw new TablesValidationError(`${field} is required`);
  if (result.length > max) throw new TablesValidationError(`${field} exceeds ${max} characters`);
  return result;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function parseDate(value: string): boolean {
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

export function validateFieldType(type: TableFieldType): void {
  if (!TABLE_FIELD_TYPES.includes(type)) throw new TablesValidationError(`Unsupported field type "${type}"`);
}

export function parseTableFieldConfig(field: Pick<TableFieldRow, 'config'>): TableFieldConfig {
  const parsed = safeJsonParse(field.config, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TableFieldConfig) : {};
}

export function buildSchemaSnapshot(tableId: number, fields: TableFieldRow[]): TableSchemaSnapshot {
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

/**
 * Shape check of a stored formula AST (no field lookups — `checkTableFormula`
 * in schema.ts adds those): known node types and operators, catalog functions
 * with their arity, and the size limits the editor enforces too.
 */
function normalizeFormulaExpression(
  expression: TableFormulaExpression,
  depth = 0,
  nodes = { count: 0 },
): TableFormulaExpression {
  nodes.count += 1;
  if (depth > TABLE_FORMULA_MAX_DEPTH || nodes.count > TABLE_FORMULA_MAX_NODES) {
    throw new TablesValidationError('Formula is too complex');
  }
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
    if (!Array.isArray(expression.args) || expression.args.length > TABLE_FORMULA_MAX_ARGS) {
      throw new TablesValidationError(`Formula function supports at most ${TABLE_FORMULA_MAX_ARGS} arguments`);
    }
    const spec = TABLE_FORMULA_FUNCTION_CATALOG[expression.name];
    if (expression.args.length < spec.minArgs || expression.args.length > (spec.maxArgs ?? TABLE_FORMULA_MAX_ARGS)) {
      const range =
        spec.maxArgs === spec.minArgs
          ? `${spec.minArgs}`
          : spec.maxArgs === null
            ? `at least ${spec.minArgs}`
            : `${spec.minArgs}-${spec.maxArgs}`;
      throw new TablesValidationError(`${expression.name.toUpperCase()} takes ${range} argument(s)`);
    }
    return {
      type: 'function',
      name: expression.name,
      args: expression.args.map((argument) => normalizeFormulaExpression(argument, depth + 1, nodes)),
    };
  }
  throw new TablesValidationError('Formula expression type is invalid');
}

export function formulaFieldIds(expression: TableFormulaExpression, result = new Set<number>()): Set<number> {
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
  if (type === 'lookup') {
    const lookup = config.lookup;
    if (!lookup || !isPositiveInteger(lookup.relationFieldId) || !isPositiveInteger(lookup.targetFieldId)) {
      throw new TablesValidationError('Lookup fields require relationFieldId and targetFieldId');
    }
    return { version: 1, lookup: { relationFieldId: lookup.relationFieldId, targetFieldId: lookup.targetFieldId } };
  }
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
    case 'lookup':
      return invalid('a computed value');
  }
}

/** A field whose value is derived (`COMPUTED_FIELD_TYPES`), never written by anyone. */
export function isComputedField(field: Pick<TableFieldRow, 'type'>): boolean {
  return isComputedFieldType(field.type);
}

/** `values ∪ computed_values` — what readers and history see. */
export function recordSnapshot(row: Pick<TableRecordRow, 'values' | 'computed_values'>): TableRecordValues {
  return { ...row.values, ...row.computed_values };
}

/**
 * Trim a record row to what `scope` may read. Full scopes pass through; scoped
 * readers lose every value (stored and computed) outside `readableFieldIds`.
 */
export function projectTableRecord<T extends Pick<TableRecordRow, 'values' | 'computed_values'>>(
  row: T,
  scope: TableAccessScope,
): T {
  if (scope.kind === 'full') return row;
  const readable = new Set(scope.readableFieldIds.map(String));
  const pick = (values: TableRecordValues): TableRecordValues =>
    Object.fromEntries(Object.entries(values).filter(([key]) => readable.has(key)));
  return { ...row, values: pick(row.values), computed_values: pick(row.computed_values) };
}

/** Refuse a malformed write meta — a programming error, never user input. */
export function assertWriteMeta(meta: TableRecordWriteMeta): void {
  if (
    !meta ||
    typeof meta.actorId !== 'string' ||
    !meta.actorId ||
    !TABLE_RECORD_ACTOR_KINDS.includes(meta.actorKind) ||
    typeof meta.enqueueAutomations !== 'boolean'
  ) {
    throw new TablesValidationError('Record write meta is invalid');
  }
}

/** Refuse a malformed scope — a programming error, never user input. */
export function assertScope(scope: TableAccessScope): void {
  if (!scope || (scope.kind !== 'full' && scope.kind !== 'scoped')) {
    throw new TablesValidationError('Table access scope is required');
  }
}
