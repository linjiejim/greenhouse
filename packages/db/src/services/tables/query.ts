/**
 * The one Tables SQL compiler.
 *
 * Every record predicate — saved views, ad-hoc queries, dashboard filters,
 * automation conditions, row scopes of custom roles (and, in Phase 1, app
 * roles) — compiles here, so "which rows match" has exactly one meaning:
 *
 * - user fields and system fields (`created_by` / `created_at` / `updated_at` /
 *   `updated_by`) in filters, sorts and grouping;
 * - parameter tokens: `$me` (user / multi_user / created_by / updated_by clauses
 *   only, resolved from the scope's user) and the date tokens of
 *   `@greenhouse/types/date-tokens` (date / datetime clauses only, resolved in
 *   the evaluation time zone). Anywhere else a token is just text;
 * - row scopes, where a reference to a missing / archived / wrong-type field
 *   compiles to FALSE (fail closed — never "drop the predicate");
 * - readable-field enforcement for scoped readers: every referenced field must
 *   be readable, and search only covers readable text fields.
 */

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { expandDateToken, isDateToken, ME_TOKEN } from '@greenhouse/types/date-tokens';
import { TABLE_FILTER_OPERATORS, TABLE_SYSTEM_FIELDS } from '@greenhouse/types/tables';
import type {
  TableFieldType,
  TableFilterClause,
  TableFilterGroup,
  TableFilterOperator,
  TableQuery,
  TableSystemField,
} from '@greenhouse/types/tables';
import type { TableAccessScope, TableRowScope } from '@greenhouse/types/table-access';
import { tableFields, tableRecords, users } from '../../schema/index.js';
import type { TableFieldRow } from '../../schema/tables.js';
import {
  escapeLike,
  isPlainObject,
  isPositiveInteger,
  MAX_QUERY_CLAUSES,
  MAX_QUERY_FILTER_GROUPS,
  MAX_QUERY_LIMIT,
  MAX_QUERY_SORTS,
  parseDate,
  parseTableFieldConfig,
  TablesValidationError,
  validateTableFieldValue,
  type TablesExecutor,
} from './shared.js';

// ─── Evaluation context ───────────────────────────────────

/** When and where a query is evaluated — only date tokens and date-only comparisons depend on it. */
export interface TableQueryEvaluation {
  /** Default: the current instant. */
  now?: Date;
  /** IANA zone for date tokens, date-only comparisons on datetimes, and date buckets. Default UTC. */
  timeZone?: string;
}

export interface ResolvedTableEvaluation {
  now: Date;
  timeZone: string;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** An unknown zone falls back to UTC rather than failing the whole query (same as the date tokens). */
export function resolveTableEvaluation(input?: TableQueryEvaluation): ResolvedTableEvaluation {
  const zone = typeof input?.timeZone === 'string' && isValidTimeZone(input.timeZone) ? input.timeZone : 'UTC';
  return { now: input?.now instanceof Date ? input.now : new Date(), timeZone: zone };
}

/** Milliseconds `timeZone` is ahead of UTC at `instant`. */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  if (timeZone === 'UTC') return 0;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'), pick('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant the calendar day `day` (YYYY-MM-DD) starts in `timeZone`. */
export function zonedDayStart(day: string, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  const utcMidnight = Date.UTC(year!, month! - 1, date!);
  const first = utcMidnight - zoneOffsetMs(utcMidnight, timeZone);
  // Re-read the offset at the candidate instant so a DST change between UTC
  // midnight and local midnight lands on the right side.
  return new Date(utcMidnight - zoneOffsetMs(first, timeZone));
}

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// ─── Compile context ──────────────────────────────────────

export interface TableCompileContext {
  tableId: number;
  fields: readonly TableFieldRow[];
  byId: ReadonlyMap<number, TableFieldRow>;
  activeUserIds: ReadonlySet<string>;
  /** Who `$me` is. Null → `$me` matches nothing. */
  userId: string | null;
  /** Field ids the reader may reference; null = every active field. */
  readable: ReadonlySet<number> | null;
  evaluation: ResolvedTableEvaluation;
}

async function activeInternalUserIds(db: TablesExecutor): Promise<Set<string>> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.status, 'active'), inArray(users.role, ['team', 'super'])));
  return new Set(rows.map((row) => row.id));
}

export function assertScopeForTable(scope: TableAccessScope, tableId: number): void {
  if (scope.kind === 'scoped' && scope.tableId !== tableId) {
    throw new TablesValidationError('Access scope does not cover this table');
  }
}

/** Load what compiling predicates on `tableId` needs, as seen by `scope`. */
export async function loadCompileContext(
  db: TablesExecutor,
  tableId: number,
  scope: TableAccessScope,
  evaluation?: TableQueryEvaluation,
): Promise<TableCompileContext> {
  assertScopeForTable(scope, tableId);
  const [fields, activeUserIds] = await Promise.all([
    db
      .select()
      .from(tableFields)
      .where(and(eq(tableFields.table_id, tableId), isNull(tableFields.archived_at)))
      .orderBy(asc(tableFields.position), asc(tableFields.id)),
    activeInternalUserIds(db),
  ]);
  return {
    tableId,
    fields,
    byId: new Map(fields.map((field) => [field.id, field])),
    activeUserIds,
    userId: scope.userId,
    readable: scope.kind === 'scoped' ? new Set(scope.readableFieldIds) : null,
    evaluation: resolveTableEvaluation(evaluation),
  };
}

// ─── Shapes ───────────────────────────────────────────────

function isSystemField(value: unknown): value is TableSystemField {
  return typeof value === 'string' && (TABLE_SYSTEM_FIELDS as readonly string[]).includes(value);
}

function isClauseShape(clause: unknown): clause is TableFilterClause {
  if (!isPlainObject(clause)) return false;
  if (!TABLE_FILTER_OPERATORS.includes(clause.operator as TableFilterOperator)) return false;
  const hasField = clause.fieldId !== undefined;
  const hasSystem = clause.systemField !== undefined;
  if (hasField === hasSystem) return false;
  return hasField ? isPositiveInteger(clause.fieldId) : isSystemField(clause.systemField);
}

function isFieldRefShape(ref: unknown): boolean {
  if (!isPlainObject(ref)) return false;
  const hasField = ref.fieldId !== undefined;
  const hasSystem = ref.systemField !== undefined;
  if (hasField === hasSystem) return false;
  return hasField ? isPositiveInteger(ref.fieldId) : isSystemField(ref.systemField);
}

export function validateFilterGroupShape(group: unknown, label = 'where'): asserts group is TableFilterGroup {
  if (
    !isPlainObject(group) ||
    !Array.isArray(group.clauses) ||
    (group.combinator !== 'and' && group.combinator !== 'or')
  ) {
    throw new TablesValidationError(`${label} must contain an and/or combinator and clauses array`);
  }
  for (const clause of group.clauses) {
    if (!isClauseShape(clause)) {
      throw new TablesValidationError('Each filter clause requires a valid fieldId or systemField and operator');
    }
  }
}

export function validateQueryShape(query: TableQuery): void {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw new TablesValidationError('query must be an object');
  }
  if (query.search !== undefined && typeof query.search !== 'string') {
    throw new TablesValidationError('search must be text');
  }
  if (query.cursor !== undefined && typeof query.cursor !== 'string') {
    throw new TablesValidationError('cursor must be text');
  }
  if (query.where !== undefined) validateFilterGroupShape(query.where, 'where');
  if (query.filters !== undefined) {
    if (!Array.isArray(query.filters) || query.filters.length > MAX_QUERY_FILTER_GROUPS) {
      throw new TablesValidationError(`filters supports at most ${MAX_QUERY_FILTER_GROUPS} groups`);
    }
    query.filters.forEach((group) => validateFilterGroupShape(group, 'Each filter group'));
  }
  if (query.sort !== undefined) {
    if (!Array.isArray(query.sort)) throw new TablesValidationError('sort must be an array');
    for (const sort of query.sort) {
      if (!isFieldRefShape(sort) || (sort.direction !== 'asc' && sort.direction !== 'desc')) {
        throw new TablesValidationError('Each sort requires one valid field and asc/desc direction');
      }
    }
  }
  if (query.groupBy !== undefined) {
    if (
      !isFieldRefShape(query.groupBy) ||
      (query.groupBy.direction !== undefined && query.groupBy.direction !== 'asc' && query.groupBy.direction !== 'desc')
    ) {
      throw new TablesValidationError('groupBy requires one valid field and an optional asc/desc direction');
    }
  }
}

// ─── Expressions ──────────────────────────────────────────

export function recordFieldJson(key: string): SQL {
  return sql`coalesce(${tableRecords.computed_values} -> ${key}, ${tableRecords.values} -> ${key})`;
}

export function recordFieldText(key: string): SQL {
  return sql`coalesce(${tableRecords.computed_values} ->> ${key}, ${tableRecords.values} ->> ${key})`;
}

export function systemColumn(field: TableSystemField): SQL {
  switch (field) {
    case 'created_by':
      return sql`${tableRecords.created_by}`;
    case 'updated_by':
      return sql`${tableRecords.updated_by}`;
    case 'created_at':
      return sql`${tableRecords.created_at}`;
    case 'updated_at':
      return sql`${tableRecords.updated_at}`;
  }
}

/** The type a field's stored / computed value behaves as in predicates. */
export function queryValueField(field: TableFieldRow): TableFieldRow {
  const config = parseTableFieldConfig(field);
  if (field.type === 'formula' && config.formula) return { ...field, type: config.formula.resultType };
  if (field.type === 'rollup' && config.rollup) {
    return { ...field, type: config.rollup.aggregation === 'join' ? 'text' : 'number' };
  }
  return field;
}

export function allowedOperators(type: TableFieldType): ReadonlySet<TableFilterOperator> {
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

const SYSTEM_USER_OPERATORS: ReadonlySet<TableFilterOperator> = new Set([
  'eq',
  'neq',
  'in',
  'is_empty',
  'is_not_empty',
]);
const SYSTEM_TIME_OPERATORS: ReadonlySet<TableFilterOperator> = new Set([
  'eq',
  'neq',
  'in',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_empty',
  'is_not_empty',
]);

const FALSE = sql`false`;
const TRUE = sql`true`;

/** `$me` with no acting user: matches nothing. */
const NO_USER = Symbol('no-user');

function unavailable(fieldId: number, tableId: number): TablesValidationError {
  return new TablesValidationError(`Field ${fieldId} is unavailable on table ${tableId}`);
}

/**
 * A field the reader references. Unreadable fields get the same message as
 * missing ones (no existence oracle) but a distinct code.
 */
export function referencedField(ctx: TableCompileContext, fieldId: number | undefined): TableFieldRow {
  const field = fieldId === undefined ? undefined : ctx.byId.get(fieldId);
  if (!field) throw unavailable(fieldId ?? 0, ctx.tableId);
  if (ctx.readable && !ctx.readable.has(field.id)) {
    throw new TablesValidationError(`Field ${field.id} is unavailable on table ${ctx.tableId}`, 'field_not_readable');
  }
  return field;
}

function equalityExpression(key: string, value: unknown): SQL {
  return sql`${recordFieldJson(key)} = ${JSON.stringify(value)}::jsonb`;
}

function emptyExpression(key: string): SQL {
  return sql`(${recordFieldJson(key)} IS NULL OR ${recordFieldJson(key)} = 'null'::jsonb OR ${recordFieldText(key)} = '')`;
}

function comparison(left: SQL, operator: 'gt' | 'gte' | 'lt' | 'lte', right: SQL): SQL {
  if (operator === 'gt') return sql`${left} > ${right}`;
  if (operator === 'gte') return sql`${left} >= ${right}`;
  if (operator === 'lt') return sql`${left} < ${right}`;
  return sql`${left} <= ${right}`;
}

function inValues(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new TablesValidationError('in expects an array with 1-50 values');
  }
  return value;
}

function resolveUserToken(value: unknown, ctx: TableCompileContext): unknown {
  if (value !== ME_TOKEN) return value;
  return ctx.userId ?? NO_USER;
}

/** Date tokens on a `date` clause become `YYYY-MM-DD` (`$now` = today). */
function resolveDateToken(value: unknown, ctx: TableCompileContext): unknown {
  if (typeof value !== 'string' || !isDateToken(value)) return value;
  const token = value.trim() === '$now' ? '$today' : value;
  return expandDateToken(token, ctx.evaluation.now, ctx.evaluation.timeZone) ?? value;
}

// Datetime targets: stored ISO text (lexicographically ordered — writes always
// normalize with toISOString) or a timestamptz system column.
interface DatetimeTarget {
  compare(operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte', iso: string): SQL;
}

function jsonDatetimeTarget(key: string): DatetimeTarget {
  return {
    compare: (operator, iso) =>
      operator === 'eq'
        ? sql`${recordFieldText(key)} = ${iso}`
        : comparison(recordFieldText(key), operator, sql`${iso}`),
  };
}

function columnDatetimeTarget(column: SQL): DatetimeTarget {
  return {
    compare: (operator, iso) =>
      operator === 'eq' ? sql`${column} = ${iso}::timestamptz` : comparison(column, operator, sql`${iso}::timestamptz`),
  };
}

/**
 * One datetime comparison. A date-only value (including day tokens) means the
 * whole calendar day in the evaluation zone: `eq` = within it, `gt` = after it,
 * `lte` = up to its end. An instant (including `$now`) compares exactly.
 */
function datetimeComparison(
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte',
  raw: unknown,
  target: DatetimeTarget,
  ctx: TableCompileContext,
  label: string,
): SQL {
  let value = raw;
  if (typeof value === 'string' && isDateToken(value)) {
    value = expandDateToken(value, ctx.evaluation.now, ctx.evaluation.timeZone) ?? value;
  }
  if (typeof value === 'string' && parseDate(value)) {
    const start = zonedDayStart(value, ctx.evaluation.timeZone).toISOString();
    const end = zonedDayStart(nextDay(value), ctx.evaluation.timeZone).toISOString();
    const within = and(target.compare('gte', start), target.compare('lt', end))!;
    switch (operator) {
      case 'eq':
        return within;
      case 'neq':
        return sql`NOT (${within})`;
      case 'gt':
        return target.compare('gte', end);
      case 'gte':
        return target.compare('gte', start);
      case 'lt':
        return target.compare('lt', start);
      case 'lte':
        return target.compare('lt', end);
    }
  }
  const parsed = typeof value === 'string' ? new Date(value) : undefined;
  if (!parsed || Number.isNaN(parsed.valueOf())) {
    throw new TablesValidationError(`Field "${label}" expects an ISO 8601 datetime`);
  }
  const iso = parsed.toISOString();
  if (operator === 'neq') return sql`NOT (${target.compare('eq', iso)})`;
  return target.compare(operator, iso);
}

function datetimeClause(
  clause: TableFilterClause,
  target: DatetimeTarget,
  ctx: TableCompileContext,
  label: string,
): SQL {
  const operator = clause.operator;
  if (operator === 'in') {
    return or(...inValues(clause.value).map((value) => datetimeComparison('eq', value, target, ctx, label)))!;
  }
  if (
    operator === 'contains' ||
    operator === 'not_contains' ||
    operator === 'is_empty' ||
    operator === 'is_not_empty'
  ) {
    throw new TablesValidationError(`Operator ${operator} is not supported for datetime`);
  }
  return datetimeComparison(operator, clause.value, target, ctx, label);
}

function systemClause(clause: TableFilterClause & { systemField: TableSystemField }, ctx: TableCompileContext): SQL {
  const operator = clause.operator;
  const column = systemColumn(clause.systemField);
  if (clause.systemField === 'created_by' || clause.systemField === 'updated_by') {
    if (!SYSTEM_USER_OPERATORS.has(operator)) {
      throw new TablesValidationError(`Operator ${operator} is not supported for ${clause.systemField}`);
    }
    // Always set — a record has a creator and a last editor.
    if (operator === 'is_empty') return FALSE;
    if (operator === 'is_not_empty') return TRUE;
    const userValue = (value: unknown): string | typeof NO_USER => {
      const resolved = resolveUserToken(value, ctx);
      if (resolved === NO_USER) return NO_USER;
      if (typeof resolved !== 'string' || !resolved || resolved.length > 200) {
        throw new TablesValidationError(`${clause.systemField} expects a user id`);
      }
      return resolved;
    };
    if (operator === 'in') {
      const ids = inValues(clause.value)
        .map(userValue)
        .filter((id): id is string => id !== NO_USER);
      return ids.length === 0 ? FALSE : or(...ids.map((id) => sql`${column} = ${id}`))!;
    }
    const id = userValue(clause.value);
    if (id === NO_USER) return operator === 'eq' ? FALSE : TRUE;
    return operator === 'eq' ? sql`${column} = ${id}` : sql`${column} <> ${id}`;
  }
  if (!SYSTEM_TIME_OPERATORS.has(operator)) {
    throw new TablesValidationError(`Operator ${operator} is not supported for ${clause.systemField}`);
  }
  if (operator === 'is_empty') return FALSE;
  if (operator === 'is_not_empty') return TRUE;
  return datetimeClause(clause, columnDatetimeTarget(column), ctx, clause.systemField);
}

function fieldClause(clause: TableFilterClause, field: TableFieldRow, ctx: TableCompileContext): SQL {
  const valueField = queryValueField(field);
  const type = valueField.type;
  const operator = clause.operator;
  if (!allowedOperators(type).has(operator)) {
    throw new TablesValidationError(`Operator ${operator} is not supported for ${field.type}`);
  }
  const key = String(field.id);
  if (operator === 'is_empty') return emptyExpression(key);
  if (operator === 'is_not_empty') return sql`NOT ${emptyExpression(key)}`;
  if (type === 'datetime') return datetimeClause(clause, jsonDatetimeTarget(key), ctx, field.name);

  const isUser = type === 'user' || type === 'multi_user';
  const resolve = (value: unknown): unknown =>
    isUser ? resolveUserToken(value, ctx) : type === 'date' ? resolveDateToken(value, ctx) : value;

  if (operator === 'contains' || operator === 'not_contains') {
    let contains: SQL;
    if (field.type === 'multi_select' || field.type === 'multi_user' || field.type === 'attachment') {
      const raw = resolve(clause.value);
      if (raw === NO_USER) {
        contains = FALSE;
      } else {
        const item =
          field.type === 'multi_user' && raw === ctx.userId
            ? raw
            : validateTableFieldValue(
                {
                  ...valueField,
                  type:
                    valueField.type === 'multi_select'
                      ? 'single_select'
                      : valueField.type === 'multi_user'
                        ? 'user'
                        : 'text',
                },
                raw,
                ctx.activeUserIds,
              );
        contains = sql`${recordFieldJson(key)} @> ${JSON.stringify([item])}::jsonb`;
      }
    } else {
      if (typeof clause.value !== 'string') {
        throw new TablesValidationError(`Field "${field.name}" contains expects text`);
      }
      contains = sql`${recordFieldText(key)} ILIKE ${`%${escapeLike(clause.value)}%`} ESCAPE '\\'`;
    }
    return operator === 'not_contains' ? sql`NOT (${contains})` : contains;
  }

  // `$me` is the acting user even when that account is not (or no longer)
  // active, so it skips the active-user check instead of failing the query.
  const scalar = (value: unknown): unknown => {
    const resolved = resolve(value);
    if (resolved === NO_USER) return NO_USER;
    if (isUser && value === ME_TOKEN) return resolved;
    return validateTableFieldValue(valueField, resolved, ctx.activeUserIds);
  };

  if (operator === 'in') {
    const expressions = inValues(clause.value)
      .map(scalar)
      .filter((value) => value !== NO_USER)
      .map((value) => equalityExpression(key, value));
    return expressions.length === 0 ? FALSE : or(...expressions)!;
  }
  const value = scalar(clause.value);
  if (value === NO_USER) return operator === 'eq' ? FALSE : TRUE;
  if (operator === 'eq') return equalityExpression(key, value);
  if (operator === 'neq') return sql`NOT (${equalityExpression(key, value)})`;
  const left = type === 'number' ? sql`NULLIF(${recordFieldText(key)}, '')::numeric` : recordFieldText(key);
  return comparison(left, operator as 'gt' | 'gte' | 'lt' | 'lte', sql`${value}`);
}

/** Compile one clause for a reader: unknown or unreadable fields are an error. */
export function compileClause(clause: TableFilterClause, ctx: TableCompileContext): SQL {
  if (!isClauseShape(clause)) {
    throw new TablesValidationError('Each filter clause requires a valid fieldId or systemField and operator');
  }
  if (clause.systemField !== undefined) {
    return systemClause(clause as TableFilterClause & { systemField: TableSystemField }, ctx);
  }
  return fieldClause(clause, referencedField(ctx, clause.fieldId), ctx);
}

/** AND / OR of a group's clauses; undefined for an empty group (no constraint). */
export function compileFilterGroup(group: TableFilterGroup, ctx: TableCompileContext): SQL | undefined {
  const parts = group.clauses.map((clause) => compileClause(clause, ctx));
  if (parts.length === 0) return undefined;
  return group.combinator === 'or' ? or(...parts)! : and(...parts)!;
}

/**
 * Compile a clause of a security predicate: anything that cannot be compiled
 * (missing / archived / wrong-type field, bad value) is FALSE, never an error
 * and never "no constraint". Row scopes are not limited to readable fields — a
 * role may be scoped by a column it cannot see.
 */
function compileScopeClause(clause: unknown, ctx: TableCompileContext): SQL {
  if (!isClauseShape(clause)) return FALSE;
  try {
    return compileClause(clause, { ...ctx, readable: null });
  } catch (error) {
    if (error instanceof TablesValidationError) return FALSE;
    throw error;
  }
}

/** One row scope → SQL. Fail closed on anything malformed or dangling. */
export function compileRowScope(rowScope: TableRowScope, ctx: TableCompileContext): SQL {
  if (!isPlainObject(rowScope)) return FALSE;
  if (rowScope.type === 'all') return TRUE;
  if (rowScope.type === 'related') {
    const userId = ctx.userId;
    if (!userId) return FALSE;
    const branches: SQL[] = [];
    if (rowScope.creator === true) branches.push(sql`${tableRecords.created_by} = ${userId}`);
    for (const fieldId of Array.isArray(rowScope.fieldIds) ? rowScope.fieldIds : []) {
      const field = isPositiveInteger(fieldId) ? ctx.byId.get(fieldId) : undefined;
      const key = String(fieldId);
      if (field?.type === 'user') branches.push(sql`${recordFieldJson(key)} = ${JSON.stringify(userId)}::jsonb`);
      else if (field?.type === 'multi_user') {
        branches.push(sql`${recordFieldJson(key)} @> ${JSON.stringify([userId])}::jsonb`);
      }
      // Missing, archived or not a person field: that branch is FALSE.
    }
    return branches.length === 0 ? FALSE : or(...branches)!;
  }
  if (rowScope.type === 'where') {
    const group = rowScope.where as unknown;
    if (
      !isPlainObject(group) ||
      !Array.isArray(group.clauses) ||
      group.clauses.length === 0 ||
      (group.combinator !== 'and' && group.combinator !== 'or')
    ) {
      // An empty or malformed security predicate grants nothing.
      return FALSE;
    }
    const parts = group.clauses.map((clause) => compileScopeClause(clause, ctx));
    return group.combinator === 'or' ? or(...parts)! : and(...parts)!;
  }
  return FALSE;
}

/**
 * The row predicate a scope imposes: `read` = every read scope; `edit` = read
 * AND every edit scope. Undefined for full access.
 */
export function scopeRowPredicate(
  scope: TableAccessScope,
  ctx: TableCompileContext,
  purpose: 'read' | 'edit',
): SQL | undefined {
  if (scope.kind === 'full') return undefined;
  const scopes = purpose === 'edit' ? [...scope.rows, ...scope.editRows] : scope.rows;
  if (scopes.length === 0) return undefined;
  return and(...scopes.map((rowScope) => compileRowScope(rowScope, ctx)))!;
}

/** Ordering expression for a sort / group key. */
export function orderExpression(
  ref: { fieldId?: number; systemField?: TableSystemField },
  ctx: TableCompileContext,
  label = 'Sort',
): SQL {
  if (ref.systemField !== undefined) return systemColumn(ref.systemField);
  const field = ctx.byId.get(ref.fieldId ?? 0);
  if (!field) throw new TablesValidationError(`${label} field ${ref.fieldId} is unavailable`);
  referencedField(ctx, field.id);
  const key = String(field.id);
  return queryValueField(field).type === 'number'
    ? sql`NULLIF(${recordFieldText(key)}, '')::numeric`
    : recordFieldText(key);
}

// ─── Cursor & fingerprint ─────────────────────────────────

function scopeFingerprint(scope: TableAccessScope): unknown {
  if (scope.kind === 'full') return { kind: 'full', userId: scope.userId };
  return {
    kind: 'scoped',
    userId: scope.userId,
    tableId: scope.tableId,
    rows: scope.rows,
    readable: [...scope.readableFieldIds].sort((a, b) => a - b),
  };
}

export function queryFingerprint(tableId: number, query: TableQuery, scope: TableAccessScope): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        tableId,
        where: query.where ?? null,
        filters: query.filters ?? [],
        search: query.search ?? null,
        sort: query.sort ?? [],
        groupBy: query.groupBy ?? null,
        scope: scopeFingerprint(scope),
      }),
    )
    .digest('base64url')
    .slice(0, 24);
}

export function encodeCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ offset, fingerprint }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined, fingerprint: string): number {
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

// ─── Whole query ──────────────────────────────────────────

export interface TableRecordQueryParts {
  where: SQL;
  order: SQL[];
  limit: number;
  offset: number;
  fingerprint: string;
}

/**
 * `where` ∧ every `filters` group ∧ search ∧ the scope's read rows, ordered by
 * `groupBy` (not counted against the sort limit) then `sort` then id.
 */
export function compileRecordQuery(
  query: TableQuery,
  scope: TableAccessScope,
  ctx: TableCompileContext,
): TableRecordQueryParts {
  validateQueryShape(query);
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new TablesValidationError(`limit must be between 1 and ${MAX_QUERY_LIMIT}`);
  }
  if (query.where && query.where.clauses.length > MAX_QUERY_CLAUSES) {
    throw new TablesValidationError(`where supports at most ${MAX_QUERY_CLAUSES} clauses`);
  }
  if (query.filters?.some((group) => group.clauses.length > MAX_QUERY_CLAUSES)) {
    throw new TablesValidationError(`Each filter group supports at most ${MAX_QUERY_CLAUSES} clauses`);
  }
  if (query.sort && query.sort.length > MAX_QUERY_SORTS) {
    throw new TablesValidationError(`sort supports at most ${MAX_QUERY_SORTS} fields`);
  }
  if (query.search && query.search.length > 200) {
    throw new TablesValidationError('search exceeds 200 characters');
  }

  const conditions: SQL[] = [eq(tableRecords.table_id, ctx.tableId), isNull(tableRecords.deleted_at)];
  const rows = scopeRowPredicate(scope, ctx, 'read');
  if (rows) conditions.push(rows);
  for (const group of [query.where, ...(query.filters ?? [])]) {
    if (!group) continue;
    const compiled = compileFilterGroup(group, ctx);
    if (compiled) conditions.push(compiled);
  }

  if (query.search?.trim()) {
    const searchable = ctx.fields.filter((field) => {
      if (ctx.readable && !ctx.readable.has(field.id)) return false;
      const valueType = queryValueField(field).type;
      return valueType === 'text' || valueType === 'long_text';
    });
    if (searchable.length === 0) {
      conditions.push(FALSE);
    } else {
      const pattern = `%${escapeLike(query.search.trim())}%`;
      conditions.push(
        or(...searchable.map((field) => sql`${recordFieldText(String(field.id))} ILIKE ${pattern} ESCAPE '\\'`))!,
      );
    }
  }

  const order: SQL[] = [];
  if (query.groupBy) {
    const expression = orderExpression(query.groupBy, ctx, 'Group');
    order.push(query.groupBy.direction === 'desc' ? desc(expression) : asc(expression));
  }
  for (const sort of query.sort ?? []) {
    const expression = orderExpression(sort, ctx);
    order.push(sort.direction === 'desc' ? desc(expression) : asc(expression));
  }
  order.push(asc(tableRecords.id));
  const fingerprint = queryFingerprint(ctx.tableId, query, scope);
  return {
    where: and(...conditions)!,
    order,
    limit,
    offset: decodeCursor(query.cursor, fingerprint),
    fingerprint,
  };
}
