/**
 * The one record query compiler: a view's filter, sorts and group, and the toolbar search, as
 * SQL over `base_records` (values by field id in jsonb; links and files in their own tables;
 * computed fields in `computed`, read as the kind they yield, a failed one as nothing).
 * Tokens resolve here: `$me` is the reader (member fields, created_by, updated_by), and the day
 * tokens are days in the reader's time zone (date and date-time fields, created_at, updated_at).
 * A clause on a field that is gone, or without the value it needs, is left out rather than
 * failing: a view must not break because a field was deleted while it was open.
 */

import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  canGroupBy,
  canSortBy,
  isComputedType,
  isSystemField,
  operatorsFor,
  valueTypeOf,
  zonedDay,
  zonedInstant,
  type Filter,
  type FilterClause,
  type ViewGroup,
  type Sort,
  type SystemField,
} from '@greenhouse/contract';
import { baseRecordFiles, baseRecordLinks, baseRecords, members, type BaseFieldRow } from '@greenhouse/db';
import { invalidInput } from '../../http/errors.js';
import { containing } from '../../http/like.js';

export interface QueryContext {
  fields: ReadonlyMap<string, BaseFieldRow>;
  memberId: string;
  timeZone: string;
  now?: Date;
}

const TRUE = sql`true`;
const FALSE = sql`false`;

/** Ids as one array parameter: no limit on how many (a list of parameters stops at 65,534). */
export const idList = (ids: readonly string[]) => sql`${sql.param([...ids])}::text[]`;
export const inIds = (column: SQLWrapper | SQL, ids: readonly string[]) => sql`${column} = ANY(${idList(ids)})`;

type FieldLike = Pick<BaseFieldRow, 'id' | 'type' | 'config'>;

/** Where a field's value is: `values`, or `computed` for formula, lookup, rollup and AI fields. */
const columnOf = (field: FieldLike) => (isComputedType(field.type) ? baseRecords.computed : baseRecords.values);
const json = (field: FieldLike) => sql`(${columnOf(field)} -> ${field.id})`;
/** A text[] literal of bound parameters. */
const textArray = (values: readonly string[]) =>
  sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
/** A scalar value as text; a computed failure (`{ error }`) or list reads as nothing. */
const text = (field: FieldLike) =>
  isComputedType(field.type)
    ? sql`(CASE WHEN jsonb_typeof(${json(field)}) IN ('string', 'number', 'boolean') THEN ${columnOf(field)} ->> ${field.id} END)`
    : sql`(${baseRecords.values} ->> ${field.id})`;
/** A number; a computed value that is not one reads as nothing. */
const numeric = (field: FieldLike) =>
  isComputedType(field.type)
    ? sql`(CASE WHEN jsonb_typeof(${json(field)}) = 'number' THEN (${columnOf(field)} ->> ${field.id})::numeric END)`
    : sql`(${text(field)})::numeric`;
const truth = (field: FieldLike) =>
  isComputedType(field.type)
    ? sql`coalesce(CASE WHEN jsonb_typeof(${json(field)}) = 'boolean' THEN (${columnOf(field)} ->> ${field.id})::boolean END, false)`
    : sql`coalesce((${text(field)})::boolean, false)`;
/** A lookup's values as text, one row each. */
const elements = (field: FieldLike) =>
  sql`jsonb_array_elements_text(CASE WHEN jsonb_typeof(${json(field)}) = 'array' THEN ${json(field)} ELSE '[]'::jsonb END)`;

/** The kind a field's value behaves as in a query: a computed one as what it yields. */
const kindOf = (field: FieldLike) =>
  valueTypeOf({ type: field.type, config: { result: (field.config as { result?: string }).result } });

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A day token or a YYYY-MM-DD as a day in the reader's zone; null for anything else. */
export function resolveDay(value: unknown, ctx: Pick<QueryContext, 'timeZone' | 'now'>): string | null {
  if (typeof value !== 'string') return null;
  const today = zonedDay((ctx.now ?? new Date()).toISOString(), ctx.timeZone);
  switch (value) {
    case '$today':
      return today;
    case '$yesterday':
      return addDays(today, -1);
    case '$tomorrow':
      return addDays(today, 1);
    case '$week_start': {
      const weekday = (new Date(`${today}T00:00:00.000Z`).getUTCDay() + 6) % 7;
      return addDays(today, -weekday);
    }
    case '$month_start':
      return `${today.slice(0, 8)}01`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

type Cmp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

function compare(left: SQL, op: Cmp, right: SQL): SQL {
  switch (op) {
    case 'eq':
      return sql`${left} = ${right}`;
    case 'neq':
      return sql`(${left} IS NULL OR ${left} <> ${right})`;
    case 'gt':
      return sql`${left} > ${right}`;
    case 'gte':
      return sql`${left} >= ${right}`;
    case 'lt':
      return sql`${left} < ${right}`;
    case 'lte':
      return sql`${left} <= ${right}`;
  }
}

/** An instant (ISO text, or a timestamptz column) against a whole day in the reader's zone. */
function dayRange(target: (bound: string) => SQL, column: SQL, op: Cmp, day: string, timeZone: string): SQL {
  const start = target(zonedInstant(day, '00:00', timeZone));
  const end = target(zonedInstant(addDays(day, 1), '00:00', timeZone));
  switch (op) {
    case 'eq':
      return sql`(${column} >= ${start} AND ${column} < ${end})`;
    case 'neq':
      return sql`(${column} IS NULL OR ${column} < ${start} OR ${column} >= ${end})`;
    case 'gt':
      return sql`${column} >= ${end}`;
    case 'gte':
      return sql`${column} >= ${start}`;
    case 'lt':
      return sql`${column} < ${start}`;
    case 'lte':
      return sql`${column} < ${end}`;
  }
}

const memberValue = (value: unknown, ctx: QueryContext): string | null =>
  value === '$me' ? ctx.memberId : typeof value === 'string' && value ? value : null;

/** Live linked records (not deleted) of a link field. */
const linksOf = (fieldId: string, target?: string) => sql`EXISTS (
  SELECT 1 FROM ${baseRecordLinks} l JOIN base_records t ON t.id = l.target_record_id AND t.deleted_at IS NULL
  WHERE l.field_id = ${fieldId} AND l.source_record_id = ${baseRecords.id}${target ? sql` AND l.target_record_id = ${target}` : sql``})`;

function systemClause(field: SystemField, clause: FilterClause, ctx: QueryContext): SQL | null {
  const op = clause.op;
  if (!operatorsFor(field).includes(op)) throw invalidInput(`${field} cannot be filtered with ${op}.`);
  if (op === 'is_empty') return FALSE;
  if (op === 'is_not_empty') return TRUE;
  if (field === 'created_by' || field === 'updated_by') {
    const column = field === 'created_by' ? baseRecords.createdBy : baseRecords.updatedBy;
    const id = memberValue(clause.value, ctx);
    if (!id) return null;
    return op === 'eq' ? sql`${column} = ${id}` : sql`(${column} IS NULL OR ${column} <> ${id})`;
  }
  const column = field === 'created_at' ? sql`${baseRecords.createdAt}` : sql`${baseRecords.updatedAt}`;
  const day = resolveDay(clause.value, ctx);
  if (!day) return null;
  return dayRange((bound) => sql`${bound}::timestamptz`, column, op as Cmp, day, ctx.timeZone);
}

function fieldClause(field: BaseFieldRow, clause: FilterClause, ctx: QueryContext): SQL | null {
  const op = clause.op;
  const kind = kindOf(field);
  if (!operatorsFor(kind).includes(op)) throw invalidInput(`「${field.name}」cannot be filtered with ${op}.`);
  const id = field.id;
  const value = clause.value;
  switch (kind) {
    case 'text':
    case 'long_text':
    case 'url':
    case 'email':
    case 'phone': {
      const empty = sql`(${text(field)} IS NULL OR ${text(field)} = '')`;
      if (op === 'is_empty') return empty;
      if (op === 'is_not_empty') return sql`NOT ${empty}`;
      if (typeof value !== 'string' || !value) return null;
      if (op === 'contains') return sql`${text(field)} ILIKE ${containing(value)}`;
      if (op === 'not_contains') return sql`(${text(field)} IS NULL OR ${text(field)} NOT ILIKE ${containing(value)})`;
      return compare(sql`lower(${text(field)})`, op as Cmp, sql`lower(${value})`);
    }
    case 'number': {
      if (op === 'is_empty') return sql`${numeric(field)} IS NULL`;
      if (op === 'is_not_empty') return sql`${numeric(field)} IS NOT NULL`;
      const number = typeof value === 'number' ? value : typeof value === 'string' && value ? Number(value) : NaN;
      if (!Number.isFinite(number)) return null;
      return compare(numeric(field), op as Cmp, sql`${number}::numeric`);
    }
    case 'checkbox': {
      if (typeof value !== 'boolean') return null;
      return sql`${truth(field)} = ${value}`;
    }
    case 'date': {
      if (op === 'is_empty') return sql`${text(field)} IS NULL`;
      if (op === 'is_not_empty') return sql`${text(field)} IS NOT NULL`;
      const day = resolveDay(value, ctx);
      if (!day) return null;
      return compare(text(field), op as Cmp, sql`${day}`);
    }
    case 'datetime': {
      if (op === 'is_empty') return sql`${text(field)} IS NULL`;
      if (op === 'is_not_empty') return sql`${text(field)} IS NOT NULL`;
      const day = resolveDay(value, ctx);
      if (!day) return null;
      // Stored as toISOString(): compared as text, they order as instants.
      return dayRange((bound) => sql`${bound}`, text(field), op as Cmp, day, ctx.timeZone);
    }
    case 'single_select': {
      if (op === 'is_empty') return sql`${text(field)} IS NULL`;
      if (op === 'is_not_empty') return sql`${text(field)} IS NOT NULL`;
      if (typeof value !== 'string' || !value) return null;
      return op === 'eq' ? sql`${text(field)} = ${value}` : sql`(${text(field)} IS NULL OR ${text(field)} <> ${value})`;
    }
    case 'multi_select':
    case 'member': {
      const empty = sql`(${json(field)} IS NULL OR ${json(field)} = '[]'::jsonb OR ${json(field)} = 'null'::jsonb)`;
      if (op === 'is_empty') return empty;
      if (op === 'is_not_empty') return sql`NOT ${empty}`;
      const wanted = field.type === 'member' ? memberValue(value, ctx) : typeof value === 'string' ? value : null;
      if (!wanted) return null;
      const has = sql`coalesce(${json(field)} @> ${JSON.stringify([wanted])}::jsonb, false)`;
      return op === 'contains' ? has : sql`NOT ${has}`;
    }
    case 'lookup': {
      const some = sql`EXISTS (SELECT 1 FROM ${elements(field)} e WHERE e <> '')`;
      if (op === 'is_empty') return sql`NOT ${some}`;
      if (op === 'is_not_empty') return some;
      if (typeof value !== 'string' || !value) return null;
      const has = sql`EXISTS (SELECT 1 FROM ${elements(field)} e WHERE e ILIKE ${containing(value)})`;
      return op === 'contains' ? has : sql`NOT ${has}`;
    }
    case 'relation':
    case 'parent':
    case 'dependency': {
      if (op === 'is_empty') return sql`NOT ${linksOf(id)}`;
      if (op === 'is_not_empty') return linksOf(id);
      if (typeof value !== 'string' || !value) return null;
      return op === 'contains' ? linksOf(id, value) : sql`NOT ${linksOf(id, value)}`;
    }
    case 'attachment': {
      const some = sql`EXISTS (SELECT 1 FROM ${baseRecordFiles} f WHERE f.record_id = ${baseRecords.id} AND f.field_id = ${id})`;
      return op === 'is_empty' ? sql`NOT ${some}` : some;
    }
    default:
      return null;
  }
}

/** The filter as one condition; clauses without what they need are left out. */
export function compileFilter(filter: Filter | undefined, ctx: QueryContext): SQL | undefined {
  if (!filter?.clauses.length) return undefined;
  const parts: SQL[] = [];
  for (const clause of filter.clauses) {
    const compiled = isSystemField(clause.field)
      ? systemClause(clause.field, clause, ctx)
      : ctx.fields.has(clause.field)
        ? fieldClause(ctx.fields.get(clause.field)!, clause, ctx)
        : null;
    if (compiled) parts.push(sql`(${compiled})`);
  }
  if (!parts.length) return undefined;
  return filter.mode === 'or' ? or(...parts) : and(...parts);
}

/**
 * A custom role's record filters as one condition: a record is seen when any of them keeps it.
 * Unlike a view's filter it fails closed: a clause on a field that is gone, or without the value
 * it needs, keeps no record (a broken rule must not show everything).
 */
export function compileRoleFilters(filters: readonly Filter[], ctx: QueryContext): SQL | undefined {
  if (!filters.length) return undefined;
  const each = filters.map((filter) => {
    const parts = filter.clauses.map((clause) => {
      let compiled: SQL | null;
      try {
        compiled = isSystemField(clause.field)
          ? systemClause(clause.field, clause, ctx)
          : ctx.fields.has(clause.field)
            ? fieldClause(ctx.fields.get(clause.field)!, clause, ctx)
            : null;
      } catch {
        compiled = null;
      }
      return compiled ? sql`(${compiled})` : FALSE;
    });
    if (!parts.length) return FALSE;
    return filter.mode === 'or' ? or(...parts)! : and(...parts)!;
  });
  return sql`(${or(...each)!})`;
}

/** Text in any text field, or an option whose label has it. */
export function compileSearch(search: string | undefined, ctx: QueryContext): SQL | undefined {
  const q = search?.trim();
  if (!q) return undefined;
  const parts: SQL[] = [];
  const needle = q.toLowerCase();
  for (const field of ctx.fields.values()) {
    if (['text', 'long_text', 'url', 'email', 'phone'].includes(kindOf(field))) {
      parts.push(sql`${text(field)} ILIKE ${containing(q)}`);
    } else if (field.type === 'lookup') {
      parts.push(sql`EXISTS (SELECT 1 FROM ${elements(field)} e WHERE e ILIKE ${containing(q)})`);
    } else if (field.type === 'single_select' || field.type === 'multi_select') {
      const ids = (field.config.options ?? [])
        .filter((option) => option.label.toLowerCase().includes(needle))
        .map((option) => option.id);
      if (!ids.length) continue;
      parts.push(
        field.type === 'single_select'
          ? inArray(sql`${text(field)}`, ids)
          : sql`coalesce(${json(field)} ?| ${textArray(ids)}, false)`,
      );
    }
  }
  return parts.length ? or(...parts) : FALSE;
}

/** What a sort or a group orders by. */
function orderKey(ref: string, ctx: QueryContext, purpose: 'sort' | 'group'): SQL | null {
  if (isSystemField(ref)) {
    if (purpose === 'group' && !canGroupBy(ref)) throw invalidInput(`Records cannot be grouped by ${ref}.`);
    switch (ref) {
      case 'created_at':
        return sql`${baseRecords.createdAt}`;
      case 'updated_at':
        return sql`${baseRecords.updatedAt}`;
      case 'created_by':
        return sql`(SELECT ${members.name} FROM ${members} WHERE ${members.id} = ${baseRecords.createdBy})`;
      case 'updated_by':
        return sql`(SELECT ${members.name} FROM ${members} WHERE ${members.id} = ${baseRecords.updatedBy})`;
    }
  }
  const field = ctx.fields.get(ref);
  if (!field) return null;
  const kind = kindOf(field);
  if (purpose === 'sort' ? !canSortBy(kind) : !canGroupBy(kind)) {
    throw invalidInput(`Records cannot be ${purpose === 'sort' ? 'sorted' : 'grouped'} by 「${field.name}」.`);
  }
  return valueKey(field);
}

/** A field's value as one ordered thing: numbers as numbers, options by their order, members by name. */
export function valueKey(field: BaseFieldRow): SQL {
  switch (kindOf(field)) {
    case 'number':
      return numeric(field);
    case 'checkbox':
      return truth(field);
    case 'single_select': {
      const ids = (field.config.options ?? []).map((option) => option.id);
      return ids.length ? sql`array_position(${textArray(ids)}, ${text(field)})` : sql`${text(field)}`;
    }
    case 'member':
      return sql`(SELECT ${members.name} FROM ${members} WHERE ${members.id} = ${json(field)} ->> 0)`;
    default:
      return sql`nullif(${text(field)}, '')`;
  }
}

/** A field's value as text (nothing for a computed failure), for grouping and charts. */
export const valueText = (field: BaseFieldRow): SQL => text(field);
/** A field's value as a number (nothing when it is not one), for sums and charts. */
export const valueNumber = (field: BaseFieldRow): SQL => numeric(field);

/** Group first (records of a group together), then the sorts, then creation order (`seq`). */
export function compileOrder(
  sorts: readonly Sort[] | undefined,
  group: ViewGroup | null | undefined,
  ctx: QueryContext,
) {
  const order: SQL[] = [];
  if (group) {
    const key = orderKey(group.field, ctx, 'group');
    if (key) order.push(group.desc ? sql`${key} DESC NULLS LAST` : sql`${key} ASC NULLS LAST`);
  }
  for (const sort of sorts ?? []) {
    const key = orderKey(sort.field, ctx, 'sort');
    if (key) order.push(sort.desc ? sql`${key} DESC NULLS LAST` : sql`${key} ASC NULLS LAST`);
  }
  order.push(asc(baseRecords.seq));
  return order;
}

/** The live records of a table that match. */
export function recordsWhere(tableId: string, ...conditions: Array<SQL | undefined>): SQL {
  return and(eq(baseRecords.tableId, tableId), isNull(baseRecords.deletedAt), ...conditions)!;
}

/**
 * Pages of a sorted query are offsets; the cursor carries the offset and a fingerprint of the
 * query, so a cursor is never read against another query.
 */
export function fingerprint(tableId: string, parts: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([tableId, parts]))
    .digest('base64url')
    .slice(0, 16);
}

export const encodeOffset = (offset: number, print: string) =>
  Buffer.from(JSON.stringify({ o: offset, f: print })).toString('base64url');

export function decodeOffset(cursor: string | undefined, print: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown; f?: unknown };
    if (typeof value.o === 'number' && Number.isInteger(value.o) && value.o >= 0 && value.f === print) return value.o;
  } catch {
    // fall through
  }
  throw invalidInput('The cursor is invalid for this query.');
}
