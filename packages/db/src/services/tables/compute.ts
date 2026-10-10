/**
 * Computed fields: formula evaluation, rollups, and the recompute paths.
 *
 * `computeRecordValues` takes the executor of the record write so a write's
 * computed values are produced inside its transaction (and visible in the
 * history event and automation conditions). Recompute and rollup cascades are
 * maintenance writes: they never append history events and never trigger
 * automations.
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { TableFieldConfig, TableFormulaExpression, TableRecordValues } from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import { tableFields, tableRecomputeJobs, tableRecords } from '../../schema/index.js';
import type { TableRecordRow } from '../../schema/tables.js';
import { parseDate, parseTableFieldConfig, type TablesExecutor } from './shared.js';

function evaluateFormula(expression: TableFormulaExpression, values: TableRecordValues): unknown {
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
}

function normalizeFormulaResult(
  resultType: NonNullable<TableFieldConfig['formula']>['resultType'],
  value: unknown,
): unknown {
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
}

export function createTablesCompute(db: Db) {
  /** Computed values (formula / rollup) for `values`, read through `executor`. */
  const computeRecordValues = async (
    executor: TablesExecutor,
    tableId: number,
    values: TableRecordValues,
  ): Promise<TableRecordValues> => {
    const fields = await executor
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
            : await executor
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
      // lookup: computed by slice Fx; creation is refused until then.
    }
    return computed;
  };

  /** Maintenance write: refresh computed values only (no revision bump, no event, no automation). */
  const recomputeRecord = async (executor: TablesExecutor, record: TableRecordRow): Promise<TableRecordRow> => {
    const computedValues = await computeRecordValues(executor, record.table_id, record.values);
    const [updated] = await executor
      .update(tableRecords)
      .set({
        computed_values: computedValues,
        computed_revision: record.computed_revision + 1,
        computed_at: nowIso(),
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
    for (const record of records) await recomputeRecord(db, record);
  };

  /** Refresh rollups on records that link to the changed target record (after the write commits). */
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
            await recomputeRecord(db, record);
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

  return { computeRecordValues, recomputeRecord, recomputeTable, refreshDependentRollups };
}

export type TablesCompute = ReturnType<typeof createTablesCompute>;
