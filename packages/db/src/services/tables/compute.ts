/**
 * Computed fields: formula evaluation, rollups, lookups, and the recompute paths.
 *
 * `computeRecordValues` takes the executor of the record write so a write's
 * computed values are produced inside its transaction (and visible in the
 * history event and automation conditions). Recompute and rollup / lookup
 * cascades are maintenance writes: they never append history events and never
 * trigger automations.
 *
 * Cascades are one level deep: a change to a record (or to a field's
 * definition) refreshes the rollups / lookups that point at it, not the
 * fields that in turn point at those. That is why a lookup may only target a
 * stored or formula field (`schema.ts`).
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { TableFieldConfig, TableRecordValues } from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import {
  tableFieldDependencies,
  tableFields,
  tableRecomputeJobs,
  tableRecordLinks,
  tableRecords,
  tableTables,
} from '../../schema/index.js';
import type { TableFieldRow, TableRecordRow } from '../../schema/tables.js';
import { evaluateTableFormula, resolveFormulaInput } from './formula-eval.js';
import { parseDate, parseTableFieldConfig, type TablesExecutor } from './shared.js';

/** Most values one lookup keeps (a relation holds ≤ 500 records; multi-value targets are flattened). */
export const MAX_LOOKUP_VALUES = 1_000;

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
  if (resultType === 'boolean') return Array.isArray(value) ? value.length > 0 : Boolean(value);
  if (resultType === 'date') {
    const date = typeof value === 'string' ? value.slice(0, 10) : '';
    return parseDate(date) ? date : null;
  }
  const date = new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/** Record ids in a relation value, in link order, without duplicates. */
function relationIds(value: unknown): number[] {
  const ids = Array.isArray(value) ? value : typeof value === 'number' ? [value] : [];
  return [...new Set(ids.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0))];
}

/** A rollup or lookup field and the relation it reads through. */
interface DependentField {
  field: TableFieldRow;
  relation: TableFieldRow;
  targetFieldId: number;
}

function linkConfig(field: TableFieldRow): { relationFieldId: number; targetFieldId: number } | undefined {
  const config = parseTableFieldConfig(field);
  if (field.type === 'rollup') return config.rollup;
  if (field.type === 'lookup') return config.lookup;
  return undefined;
}

function rollupValue(aggregation: NonNullable<TableFieldConfig['rollup']>['aggregation'], values: unknown[]): unknown {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (aggregation === 'count') return present.length;
  if (aggregation === 'join') return present.map(String).join(', ');
  const numbers = present.map(Number).filter(Number.isFinite);
  if (aggregation === 'sum') return numbers.reduce((sum, value) => sum + value, 0);
  if (numbers.length === 0) return null;
  if (aggregation === 'avg') return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  return aggregation === 'min' ? Math.min(...numbers) : Math.max(...numbers);
}

export function createTablesCompute(db: Db) {
  /** Computed values (formula / rollup / lookup) for `values`, read through `executor`. */
  const computeRecordValues = async (
    executor: TablesExecutor,
    tableId: number,
    values: TableRecordValues,
    previousComputed: TableRecordValues = {},
  ): Promise<TableRecordValues> => {
    const fields = await executor
      .select()
      .from(tableFields)
      .where(and(eq(tableFields.table_id, tableId), isNull(tableFields.archived_at)))
      .orderBy(asc(tableFields.position), asc(tableFields.id));
    const fieldsById = new Map(fields.map((field) => [field.id, field]));
    const inputs = new Map(
      fields.map((field) => [field.id, { type: field.type, config: parseTableFieldConfig(field) }]),
    );
    // Only active fields feed a formula: an archived (or unknown) source reads
    // as empty, so its stored values stop surfacing through the formula.
    const formulaRead = (fieldId: number): unknown => {
      const input = inputs.get(fieldId);
      return input ? resolveFormulaInput(input, values[String(fieldId)]) : null;
    };

    // Rollups and lookups read the linked records: load them (and their target
    // fields) once per target table instead of once per field.
    const links = fields.flatMap((field) => {
      const link = linkConfig(field);
      if (!link) return [];
      const relation = fieldsById.get(link.relationFieldId);
      const targetTableId =
        relation?.type === 'relation' ? parseTableFieldConfig(relation).relation?.targetTableId : undefined;
      const recordIds = targetTableId ? relationIds(values[String(link.relationFieldId)]) : [];
      return [{ field, targetTableId: targetTableId ?? 0, targetFieldId: link.targetFieldId, recordIds }];
    });
    const recordIdsByTable = new Map<number, Set<number>>();
    for (const link of links) {
      if (!link.targetTableId || link.recordIds.length === 0) continue;
      const ids = recordIdsByTable.get(link.targetTableId) ?? new Set<number>();
      link.recordIds.forEach((id) => ids.add(id));
      recordIdsByTable.set(link.targetTableId, ids);
    }
    const targetRecords = new Map<number, TableRecordRow>();
    for (const [targetTableId, ids] of recordIdsByTable) {
      const rows = await executor
        .select()
        .from(tableRecords)
        .where(
          and(
            eq(tableRecords.table_id, targetTableId),
            inArray(tableRecords.id, [...ids]),
            isNull(tableRecords.deleted_at),
          ),
        );
      rows.forEach((row) => targetRecords.set(row.id, row));
    }
    const targetFieldIds = [...new Set(links.filter((link) => link.targetTableId).map((link) => link.targetFieldId))];
    const targetFields = new Map<number, TableFieldRow>();
    if (targetFieldIds.length > 0) {
      const rows = await executor
        .select()
        .from(tableFields)
        .where(and(inArray(tableFields.id, targetFieldIds), isNull(tableFields.archived_at)));
      rows.forEach((row) => targetFields.set(row.id, row));
    }

    const computed: TableRecordValues = {};
    for (const field of fields) {
      const config = parseTableFieldConfig(field);
      if (field.type === 'ai') {
        if (String(field.id) in previousComputed) computed[String(field.id)] = previousComputed[String(field.id)];
        continue;
      }
      if (field.type === 'formula' && config.formula) {
        computed[String(field.id)] = normalizeFormulaResult(
          config.formula.resultType,
          evaluateTableFormula(config.formula.expression, formulaRead),
        );
        continue;
      }
      const link = links.find((entry) => entry.field.id === field.id);
      if (!link) continue;
      const targetField = targetFields.get(link.targetFieldId);
      const sameTable = targetField?.table_id === link.targetTableId ? targetField : undefined;
      const targetInput = sameTable ? { type: sameTable.type, config: parseTableFieldConfig(sameTable) } : undefined;
      const key = String(link.targetFieldId);
      // A rollup / lookup whose target field is gone (archived / moved) reads
      // nothing: the archived column's stored values never feed it.
      const linked = sameTable
        ? link.recordIds
            .map((id) => targetRecords.get(id))
            .filter((row): row is TableRecordRow => row !== undefined && row.table_id === link.targetTableId)
            .map((row) =>
              resolveFormulaInput(targetInput, key in row.computed_values ? row.computed_values[key] : row.values[key]),
            )
        : [];
      if (field.type === 'rollup' && config.rollup) {
        computed[String(field.id)] = rollupValue(config.rollup.aggregation, linked);
      } else if (field.type === 'lookup') {
        computed[String(field.id)] = linked
          .flatMap((value) => (Array.isArray(value) ? value : [value]))
          .filter((value) => !isBlank(value))
          .slice(0, MAX_LOOKUP_VALUES);
      }
    }
    return computed;
  };

  /** Maintenance write: refresh computed values only (no revision bump, no event, no automation). */
  const recomputeRecord = async (snapshot: TableRecordRow): Promise<TableRecordRow> =>
    db.transaction(async (tx) => {
      // A rollup refresh may have waited behind an AI completion or record edit.
      // Always recompute the locked live row so it cannot erase those values.
      const [record] = await tx
        .select()
        .from(tableRecords)
        .where(and(eq(tableRecords.id, snapshot.id), isNull(tableRecords.deleted_at)))
        .for('update');
      if (!record) return snapshot;
      const computedValues = await computeRecordValues(tx, record.table_id, record.values, record.computed_values);
      const [updated] = await tx
        .update(tableRecords)
        .set({
          computed_values: computedValues,
          computed_revision: record.computed_revision + 1,
          computed_at: nowIso(),
        })
        .where(eq(tableRecords.id, record.id))
        .returning();
      return updated ?? record;
    });

  const recomputeTable = async (tableId: number): Promise<void> => {
    const records = await db
      .select()
      .from(tableRecords)
      .where(and(eq(tableRecords.table_id, tableId), isNull(tableRecords.deleted_at)));
    for (const record of records) await recomputeRecord(record);
  };

  /**
   * The rollup / lookup fields that read `targetTableId` through a relation.
   * Relations never leave their Base, so only that Base's active tables are
   * scanned — not every rollup in the database.
   */
  const dependentFields = async (targetTableId: number): Promise<DependentField[]> => {
    const [target] = await db
      .select({ base_id: tableTables.base_id })
      .from(tableTables)
      .where(eq(tableTables.id, targetTableId))
      .limit(1);
    if (!target) return [];
    const rows = await db
      .select({ field: tableFields })
      .from(tableFields)
      .innerJoin(tableTables, eq(tableTables.id, tableFields.table_id))
      .where(
        and(
          eq(tableTables.base_id, target.base_id),
          isNull(tableTables.archived_at),
          isNull(tableFields.archived_at),
          inArray(tableFields.type, ['relation', 'rollup', 'lookup']),
        ),
      );
    const relations = new Map(
      rows
        .map((row) => row.field)
        .filter(
          (field) =>
            field.type === 'relation' && parseTableFieldConfig(field).relation?.targetTableId === targetTableId,
        )
        .map((field) => [field.id, field]),
    );
    if (relations.size === 0) return [];
    return rows.flatMap(({ field }) => {
      const link = linkConfig(field);
      const relation = link ? relations.get(link.relationFieldId) : undefined;
      if (!link || !relation || relation.table_id !== field.table_id) return [];
      return [{ field, relation, targetFieldId: link.targetFieldId }];
    });
  };

  /** Records (not deleted) linking through any of `relationFieldIds`, optionally only to `targetRecordId`. */
  const linkingRecords = async (
    relationFieldIds: number[],
    targetRecordId?: number,
  ): Promise<Array<{ record: TableRecordRow; relationFieldIds: Set<number> }>> => {
    if (relationFieldIds.length === 0) return [];
    const linkRows = await db
      .select({ field_id: tableRecordLinks.field_id, source_record_id: tableRecordLinks.source_record_id })
      .from(tableRecordLinks)
      .where(
        and(
          inArray(tableRecordLinks.field_id, relationFieldIds),
          targetRecordId === undefined ? undefined : eq(tableRecordLinks.target_record_id, targetRecordId),
        ),
      );
    const bySource = new Map<number, Set<number>>();
    for (const link of linkRows) {
      const fields = bySource.get(link.source_record_id) ?? new Set<number>();
      fields.add(link.field_id);
      bySource.set(link.source_record_id, fields);
    }
    if (bySource.size === 0) return [];
    const records = await db
      .select()
      .from(tableRecords)
      .where(and(inArray(tableRecords.id, [...bySource.keys()]), isNull(tableRecords.deleted_at)))
      .orderBy(asc(tableRecords.id));
    return records.map((record) => ({ record, relationFieldIds: bySource.get(record.id)! }));
  };

  /**
   * After a target record changed (update / delete / restore, after commit):
   * recompute the records that link to it from tables whose rollups or
   * lookups read its table. One recompute per linking record; each dependent
   * field logs an idempotent job keyed by the target's revision.
   */
  const refreshDependentRollups = async (targetTableId: number, targetRecordId: number): Promise<void> => {
    const dependents = await dependentFields(targetTableId);
    if (dependents.length === 0) return;
    const [targetRecord] = await db
      .select({ revision: tableRecords.revision, deleted_at: tableRecords.deleted_at })
      .from(tableRecords)
      .where(eq(tableRecords.id, targetRecordId))
      .limit(1);
    const targetVersion = `${targetRecord?.revision ?? 0}:${targetRecord?.deleted_at ? 'deleted' : 'active'}`;
    const sources = await linkingRecords(
      [...new Set(dependents.map((dependent) => dependent.relation.id))],
      targetRecordId,
    );
    for (const { record, relationFieldIds } of sources) {
      const fields = dependents.filter(
        (dependent) => dependent.field.table_id === record.table_id && relationFieldIds.has(dependent.relation.id),
      );
      const now = nowIso();
      const jobs = [];
      for (const { field } of fields) {
        const [job] = await db
          .insert(tableRecomputeJobs)
          .values({
            table_id: record.table_id,
            field_id: field.id,
            record_id: record.id,
            status: 'running',
            attempt: 1,
            idempotency_key: `${field.type}:${field.id}:${record.id}:${targetRecordId}:${targetVersion}`,
            created_at: now,
            started_at: now,
          })
          .onConflictDoNothing()
          .returning({ id: tableRecomputeJobs.id });
        if (job) jobs.push(job.id);
      }
      if (jobs.length === 0) continue;
      try {
        await recomputeRecord(record);
        await db
          .update(tableRecomputeJobs)
          .set({ status: 'succeeded', finished_at: nowIso() })
          .where(inArray(tableRecomputeJobs.id, jobs));
      } catch (error) {
        await db
          .update(tableRecomputeJobs)
          .set({
            status: 'failed',
            error: error instanceof Error ? error.message.slice(0, 2_000) : 'Unknown recompute error',
            finished_at: nowIso(),
          })
          .where(inArray(tableRecomputeJobs.id, jobs));
        throw error;
      }
    }
  };

  /**
   * After a field's definition changed (computed config, select options,
   * archive): recompute its own table when its values or a same-table computed
   * field reading it (a formula, or a rollup / lookup through it as the
   * relation) changed, then every linking record in tables whose rollups /
   * lookups target it (or a same-table field that reads it).
   */
  const refreshAfterFieldChange = async (
    field: Pick<TableFieldRow, 'id' | 'table_id'>,
    options: { computed: boolean },
  ): Promise<void> => {
    const readers = await db
      .select({ field_id: tableFieldDependencies.field_id })
      .from(tableFieldDependencies)
      .innerJoin(tableFields, eq(tableFields.id, tableFieldDependencies.field_id))
      .where(
        and(
          eq(tableFieldDependencies.depends_on_field_id, field.id),
          eq(tableFields.table_id, field.table_id),
          isNull(tableFields.archived_at),
        ),
      );
    if (options.computed || readers.length > 0) await recomputeTable(field.table_id);
    const changed = new Set([field.id, ...readers.map((row) => row.field_id)]);
    const dependents = (await dependentFields(field.table_id)).filter((dependent) =>
      changed.has(dependent.targetFieldId),
    );
    const sources = await linkingRecords([...new Set(dependents.map((dependent) => dependent.relation.id))]);
    for (const { record } of sources) await recomputeRecord(record);
  };

  return { computeRecordValues, recomputeRecord, recomputeTable, refreshDependentRollups, refreshAfterFieldChange };
}

export type TablesCompute = ReturnType<typeof createTablesCompute>;
