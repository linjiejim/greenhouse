/**
 * The one card evaluator (program principle P1): Tables dashboard widgets now,
 * Phase 1 app cards next — both hand a `TableCardSpec` and a reader's scope to
 * `evaluateTableCard`, and nothing else turns a card into numbers or rows.
 *
 * What it adds on top of the scoped db reads (`aggregateRecords` /
 * `queryRecords`, which enforce the row scope and readable fields themselves):
 *
 * - filter controls: the dashboard's (or page's) controls, trimmed to targets
 *   on this card's table that the reader can read — a control on a field the
 *   reader cannot see is ignored even if a value is sent for it, so a viewer
 *   never controls a predicate over hidden data;
 * - date buckets and date tokens in the reader's time zone;
 * - drill-down: the records behind one chart point / pivot cell, through the
 *   same query, filters and scope (`drilldownFilters`).
 *
 * Callers trim the card itself for restricted readers first
 * (`trimCardForReader` — a card whose predicate needs a hidden field is never
 * evaluated for them); the db layer would refuse it anyway.
 */

import {
  parseTableFieldConfig,
  projectTableRecord,
  resolveTableEvaluation,
  TablesValidationError,
  type DatabaseProvider,
  type TableFieldRow,
  type TableRecordQueryResult,
} from '@greenhouse/db';
import type { TableAccessScope } from '@greenhouse/types/table-access';
import {
  drilldownFilters,
  filterGroupsForTable,
  mergeFilterGroups,
  TABLE_CARD_LIMITS,
  trimFilterControlsForReader,
  type TableCardPoint,
  type TableCardResult,
  type TableFieldTypeOf,
} from '@greenhouse/types/table-cards';
import type {
  TableAggregateRow,
  TableCardSpec,
  TableFieldType,
  TableFilterControl,
  TableFilterValue,
  TableQuery,
} from '@greenhouse/types/tables';

export interface TableCardEvaluationOptions {
  /** The dashboard's / page's filter controls (any table — only this card's table's targets apply). */
  controls?: readonly TableFilterControl[];
  /** Viewer values by control id; a present `null` clears a control's default. */
  filterValues?: Readonly<Record<string, unknown>>;
  /** The reader's IANA zone: date buckets, presets and date tokens. Unknown → UTC. */
  timezone?: string;
  now?: Date;
  /** Return the records behind this point instead of the card's own result. */
  drilldown?: TableCardPoint;
  /** Next page of a records card or a drill-down. */
  cursor?: string;
  /** The card table's active fields when the caller already read them in this request (else read here). */
  fields?: readonly TableFieldRow[];
}

export type TableCardEvaluation = TableCardResult<TableRecordQueryResult>;

/**
 * The type a field's value behaves as — formula → its result type, rollup →
 * number / text. Mirrors the compiler's `queryValueField` (package-internal to
 * packages/db) for the two decisions made here: `in` vs `contains` for a
 * multi-value target, and how a drill-down key is typed.
 */
function valueType(field: TableFieldRow): TableFieldType {
  const config = parseTableFieldConfig(field);
  if (field.type === 'formula' && config.formula) return config.formula.resultType;
  if (field.type === 'rollup' && config.rollup) return config.rollup.aggregation === 'join' ? 'text' : 'number';
  return field.type;
}

function isTimeGroup(spec: TableCardSpec): boolean {
  const groupBy = spec.aggregate?.groupBy;
  return Boolean(groupBy?.dateBucket || groupBy?.systemField === 'created_at' || groupBy?.systemField === 'updated_at');
}

/**
 * Rows fetched latest-first back in reading order: oldest → newest, the
 * no-date bucket last, each group's series in the order they came.
 */
function chronological(rows: readonly TableAggregateRow[]): TableAggregateRow[] {
  const keyOf = (row: TableAggregateRow): string | null => (row.group === null ? null : String(row.group));
  const latestFirst = [...new Set(rows.map(keyOf))];
  const order: Array<string | null> = latestFirst.filter((key) => key !== null).reverse();
  if (latestFirst.includes(null)) order.push(null);
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...rows].sort((left, right) => rank.get(keyOf(left))! - rank.get(keyOf(right))!);
}

/**
 * Select values the target field no longer offers are dropped before they
 * reach the compiler (which would refuse an unknown option and fail the card):
 * a stale default never breaks a dashboard.
 */
function liveSelectValues(
  controls: readonly TableFilterControl[],
  values: Readonly<Record<string, unknown>> | undefined,
  fields: ReadonlyMap<number, TableFieldRow>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = { ...(values ?? {}) };
  let changed = false;
  for (const control of controls) {
    if (control.kind !== 'select') continue;
    const chosen = values && Object.prototype.hasOwnProperty.call(values, control.id);
    const value = (chosen ? values[control.id] : control.defaultValue) as TableFilterValue | null | undefined;
    if (!value || value.kind !== 'select' || !Array.isArray(value.values)) continue;
    const offered = new Set<string>();
    for (const target of control.targets) {
      const field = target.fieldId === undefined ? undefined : fields.get(target.fieldId);
      for (const option of field ? (parseTableFieldConfig(field).options ?? []) : []) offered.add(option.id);
    }
    out[control.id] = { kind: 'select', values: value.values.filter((option) => offered.has(option)) };
    changed = true;
  }
  return changed ? out : values;
}

/**
 * Evaluate one card for one reader. Text cards need no table; every other kind
 * reads `spec.source.tableId` under `scope` (which must cover that table).
 */
export async function evaluateTableCard(
  db: DatabaseProvider,
  spec: TableCardSpec,
  options: TableCardEvaluationOptions,
  scope: TableAccessScope,
): Promise<TableCardEvaluation> {
  if (spec.kind === 'text') return { kind: 'text', markdown: spec.markdown ?? '' };
  const tableId = spec.source?.tableId;
  if (!tableId) throw new TablesValidationError('This card has no source table');

  const fields = (options.fields ?? (await db.tables.listFields(tableId))).filter(
    (field) => !field.archived_at && field.table_id === tableId,
  );
  const byId = new Map(fields.map((field) => [field.id, field]));
  const readable =
    scope.kind === 'scoped'
      ? new Set(fields.filter((field) => scope.readableFieldIds.includes(field.id)).map((field) => field.id))
      : new Set(fields.map((field) => field.id));
  const fieldType: TableFieldTypeOf = ({ fieldId }) => {
    const field = byId.get(fieldId);
    return field ? valueType(field) : undefined;
  };
  const { timeZone } = resolveTableEvaluation({ timeZone: options.timezone });
  const now = options.now ?? new Date();

  // Only targets on this table that this reader can read; anything else is ignored.
  const controls = trimFilterControlsForReader(options.controls ?? [], (id) => (id === tableId ? readable : undefined));
  const values = liveSelectValues(controls, options.filterValues, byId);
  const groups = filterGroupsForTable(controls, values, tableId, timeZone, { now, fieldType });
  if (options.drilldown) groups.push(drilldownFilters(spec, options.drilldown, fieldType));
  const { filters: ownFilters, ...sourceQuery } = spec.source?.query ?? {};
  const filters = mergeFilterGroups([...(ownFilters ?? []), ...groups]);
  const query: Omit<TableQuery, 'cursor' | 'limit'> = { ...sourceQuery, ...(filters.length > 0 ? { filters } : {}) };

  if (options.drilldown || spec.kind === 'records') {
    const limit = options.drilldown ? TABLE_CARD_LIMITS.drilldown : (spec.limit ?? TABLE_CARD_LIMITS.defaultRecords);
    const page = await db.tables.queryRecords(
      tableId,
      { ...query, limit, ...(options.cursor ? { cursor: options.cursor } : {}) },
      scope,
      { timeZone, now },
    );
    return { kind: 'records', page: { ...page, records: page.records.map((row) => projectTableRecord(row, scope)) } };
  }

  const aggregate = spec.aggregate ?? { operation: 'count' as const };
  if (spec.kind === 'kpi') {
    const rows = await db.tables.aggregateRecords(
      tableId,
      { operation: aggregate.operation, valueFieldId: aggregate.valueFieldId, query, timezone: timeZone },
      scope,
    );
    return { kind: 'kpi', value: rows[0]?.value ?? 0 };
  }

  const kind = spec.kind === 'pivot' ? 'pivot' : 'chart';
  // Time reads left to right and, when the buckets outnumber the limit, keeps
  // the latest ones: fetch newest first, then put them back in order.
  // Categories read biggest first.
  const latestTime = aggregate.sort === undefined && isTimeGroup(spec);
  const rows = await db.tables.aggregateRecords(
    tableId,
    {
      operation: aggregate.operation,
      valueFieldId: aggregate.valueFieldId,
      groupBy: aggregate.groupBy,
      series: aggregate.series,
      sort: aggregate.sort ?? (latestTime ? 'group_desc' : 'value_desc'),
      limit: aggregate.limit,
      query,
      timezone: timeZone,
    },
    scope,
  );
  return { kind, rows: latestTime ? chronological(rows) : rows };
}
