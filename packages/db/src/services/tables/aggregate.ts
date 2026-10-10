/**
 * Record aggregates for dashboards and (Phase 1) app cards: one operation over
 * the query's rows, optionally grouped (with date buckets in the viewer's time
 * zone) and split by a second dimension (`series`).
 *
 * Every referenced field — value, group, series, and everything in the query —
 * must be readable by the scope; the row scope applies through the query.
 */

import { sql, type SQL } from 'drizzle-orm';
import { TABLE_AGGREGATIONS, TABLE_DATE_BUCKETS, TABLE_SYSTEM_FIELDS } from '@greenhouse/types/tables';
import type {
  TableAggregateInput,
  TableAggregateRow,
  TableDateBucket,
  TableQuery,
  TableSystemField,
} from '@greenhouse/types/tables';
import type { TableAccessScope } from '@greenhouse/types/table-access';
import type { Db } from '../../client.js';
import { tableRecords } from '../../schema/index.js';
import {
  compileRecordQuery,
  loadCompileContext,
  queryValueField,
  recordFieldText,
  referencedField,
  systemColumn,
  type TableCompileContext,
} from './query.js';
import { assertScope, isPlainObject, isPositiveInteger, TablesValidationError } from './shared.js';

const MAX_AGGREGATE_GROUPS = 100;
const MAX_SERIES_ROWS = 2_000;

type DimensionRef = { fieldId?: number; systemField?: TableSystemField; dateBucket?: TableDateBucket };

function validDimension(ref: unknown, label: string, allowBucket: boolean): DimensionRef {
  if (!isPlainObject(ref)) throw new TablesValidationError(`${label} must be an object`);
  const hasField = ref.fieldId !== undefined;
  const hasSystem = ref.systemField !== undefined;
  if (hasField === hasSystem) throw new TablesValidationError(`${label} requires exactly one of fieldId / systemField`);
  if (hasField && !isPositiveInteger(ref.fieldId)) throw new TablesValidationError(`${label} fieldId is invalid`);
  if (hasSystem && !TABLE_SYSTEM_FIELDS.includes(ref.systemField as TableSystemField)) {
    throw new TablesValidationError(`${label} systemField is invalid`);
  }
  if (ref.dateBucket !== undefined) {
    if (!allowBucket || !TABLE_DATE_BUCKETS.includes(ref.dateBucket as TableDateBucket)) {
      throw new TablesValidationError(`${label} dateBucket is invalid`);
    }
  }
  return ref as DimensionRef;
}

/** `YYYY-MM-DD` of the bucket start, in the evaluation zone for instants. */
function bucketExpression(bucket: TableDateBucket, timestamp: SQL, timeZone: string): SQL {
  return sql`to_char(date_trunc(${bucket}, (${timestamp}) AT TIME ZONE ${timeZone}), 'YYYY-MM-DD')`;
}

function dimensionExpression(ref: DimensionRef, ctx: TableCompileContext, label: string): SQL {
  const zone = ctx.evaluation.timeZone;
  if (ref.systemField !== undefined) {
    const column = systemColumn(ref.systemField);
    if (ref.systemField === 'created_by' || ref.systemField === 'updated_by') {
      if (ref.dateBucket) throw new TablesValidationError(`${label} dateBucket requires a date field`);
      return column;
    }
    // Grouping by raw instants is never what anyone wants: default to days.
    return bucketExpression(ref.dateBucket ?? 'day', column, zone);
  }
  const field = referencedField(ctx, ref.fieldId);
  const key = String(field.id);
  const text = recordFieldText(key);
  const valueType = queryValueField(field).type;
  if (!ref.dateBucket) return text;
  if (valueType === 'date') {
    return sql`CASE WHEN ${text} ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN to_char(date_trunc(${ref.dateBucket}, (${text})::date::timestamp), 'YYYY-MM-DD') END`;
  }
  if (valueType === 'datetime') {
    return sql`CASE WHEN ${text} ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN ${bucketExpression(ref.dateBucket, sql`(${text})::timestamptz`, zone)} END`;
  }
  throw new TablesValidationError(`${label} dateBucket requires a date or datetime field`);
}

function groupValue(value: unknown): string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : String(value);
}

export function createTablesAggregates(db: Db) {
  return {
    async aggregateRecords(
      tableId: number,
      input: TableAggregateInput,
      scope: TableAccessScope,
    ): Promise<TableAggregateRow[]> {
      assertScope(scope);
      if (!isPlainObject(input) || !TABLE_AGGREGATIONS.includes(input.operation)) {
        throw new TablesValidationError(`Unsupported aggregation "${String(input?.operation)}"`);
      }
      const ctx = await loadCompileContext(db, tableId, scope, { timeZone: input.timezone });
      const query: TableQuery = { ...(input.query ?? {}), limit: 1 };
      const parts = compileRecordQuery(query, scope, ctx);

      const valueField = input.valueFieldId !== undefined ? ctx.byId.get(input.valueFieldId) : undefined;
      if (input.valueFieldId !== undefined && valueField) referencedField(ctx, valueField.id);
      if (input.operation !== 'count' && (!valueField || queryValueField(valueField).type !== 'number')) {
        throw new TablesValidationError(`${input.operation} requires a numeric valueFieldId`);
      }
      const numberExpr = valueField ? sql`NULLIF(${recordFieldText(String(valueField.id))}, '')::numeric` : sql`1`;
      let aggregate: SQL;
      if (input.operation === 'sum') aggregate = sql`coalesce(sum(${numberExpr}), 0)`;
      else if (input.operation === 'avg') aggregate = sql`coalesce(avg(${numberExpr}), 0)`;
      else if (input.operation === 'min') aggregate = sql`coalesce(min(${numberExpr}), 0)`;
      else if (input.operation === 'max') aggregate = sql`coalesce(max(${numberExpr}), 0)`;
      else aggregate = sql`count(*)`;

      const groupRef =
        input.groupBy !== undefined
          ? validDimension(input.groupBy, 'groupBy', true)
          : input.groupByFieldId !== undefined
            ? validDimension({ fieldId: input.groupByFieldId }, 'groupByFieldId', false)
            : undefined;
      const seriesRef = input.series !== undefined ? validDimension(input.series, 'series', false) : undefined;
      if (seriesRef && !groupRef) throw new TablesValidationError('series requires groupBy');

      if (!groupRef) {
        const rows = await db.select({ value: aggregate }).from(tableRecords).where(parts.where);
        return [{ group: null, value: Number(rows[0]?.value ?? 0) }];
      }

      const sort = input.sort ?? 'value_desc';
      if (!['value_desc', 'value_asc', 'group_asc', 'group_desc'].includes(sort)) {
        throw new TablesValidationError('sort is invalid');
      }
      const limit = Math.min(Math.max(input.limit ?? 20, 1), MAX_AGGREGATE_GROUPS);
      // PostgreSQL treats separately-bound JSON path parameters in SELECT and
      // GROUP BY as distinct expressions; grouping / ordering by position keeps
      // each validated expression single-sourced.
      const order =
        sort === 'value_desc'
          ? sql.raw('2 DESC, 1 ASC NULLS LAST')
          : sort === 'value_asc'
            ? sql.raw('2 ASC, 1 ASC NULLS LAST')
            : sort === 'group_desc'
              ? sql.raw('1 DESC NULLS LAST')
              : sql.raw('1 ASC NULLS LAST');
      const groupExpr = dimensionExpression(groupRef, ctx, 'groupBy');
      const groups = await db
        .select({ group: groupExpr, value: aggregate })
        .from(tableRecords)
        .where(parts.where)
        .groupBy(sql.raw('1'))
        .orderBy(order)
        .limit(limit);
      if (!seriesRef) return groups.map((row) => ({ group: groupValue(row.group), value: Number(row.value) }));

      // Second dimension over the top groups only, so a stacked chart's bars
      // are the same groups an unstacked one would show.
      if (groups.length === 0) return [];
      const keys = groups.map((row) => (row.group === null ? null : String(row.group)));
      const nonNull = keys.filter((key): key is string => key !== null);
      const inGroups = sql.join(
        [
          ...(nonNull.length > 0
            ? [
                sql`(${dimensionExpression(groupRef, ctx, 'groupBy')}) IN (${sql.join(
                  nonNull.map((key) => sql`${key}`),
                  sql`, `,
                )})`,
              ]
            : []),
          ...(keys.includes(null) ? [sql`(${dimensionExpression(groupRef, ctx, 'groupBy')}) IS NULL`] : []),
        ],
        sql` OR `,
      );
      const seriesExpr = dimensionExpression(seriesRef, ctx, 'series');
      const rows = await db
        .select({ group: dimensionExpression(groupRef, ctx, 'groupBy'), series: seriesExpr, value: aggregate })
        .from(tableRecords)
        .where(sql`${parts.where} AND (${inGroups})`)
        .groupBy(sql.raw('1, 2'))
        .orderBy(sql.raw('1 ASC NULLS LAST, 2 ASC NULLS LAST'))
        .limit(MAX_SERIES_ROWS);
      const rank = new Map(keys.map((key, index) => [key, index]));
      return rows
        .map((row) => ({
          group: groupValue(row.group),
          series: groupValue(row.series),
          value: Number(row.value),
        }))
        .sort(
          (left, right) =>
            (rank.get(left.group === null ? null : String(left.group)) ?? 0) -
            (rank.get(right.group === null ? null : String(right.group)) ?? 0),
        );
    },
  };
}
