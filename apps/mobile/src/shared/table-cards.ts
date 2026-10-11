/**
 * VENDORED verbatim from packages/types/src/table-cards.ts — apps/mobile is outside the
 * pnpm workspace and cannot import @greenhouse/types. Never edit below this
 * header: change the canonical file and copy it again (table-cards.parity.test.ts in
 * the root vitest fails on any drift). Sibling `./x.js` imports resolve to the
 * vendored `./x.ts` (metro.config.js; TypeScript's bundler resolution).
 */

/**
 * Pure helpers over the unified card specification (`TableCardSpec` in
 * `./tables`): dashboard widgets now, app cards in Phase 1.
 *
 * The evaluator itself is server-side (apps/api/src/platform/tables/cards.ts);
 * this module holds only what the server, the web client and (Phase 1) the app
 * renderer must agree on:
 *
 * - the card shape (`normalizeTableCardSpec`) and the stored widget `type` it
 *   implies (`widgetTypeForCard`), plus the mapping of legacy flat widget
 *   configs onto a card (`legacyWidgetToCard`);
 * - dashboard filter controls: shape (`normalizeFilterControl`), viewer values
 *   (`normalizeFilterValue`) and the predicates a value adds to a card's query
 *   (`filterValueToGroups`, `filterGroupsForTable`, `mergeFilterGroups`);
 * - drill-down: the predicate selecting the records behind one chart point /
 *   pivot cell (`drilldownFilters`, `bucketRange`);
 * - what a restricted reader may see of a card or a control
 *   (`trimCardForReader`, `trimFilterControlsForReader`).
 *
 * Every predicate produced here is ordinary `TableFilterGroup` data: the one
 * SQL compiler expands it (date-only bounds mean whole calendar days in the
 * evaluation zone, `$me` is the reader) and enforces readable fields again.
 *
 * Dependency-free apart from `./tables` and `./date-tokens`.
 */

import { expandDateToken } from './date-tokens.js';
import {
  TABLE_AGGREGATIONS,
  TABLE_DATE_BUCKETS,
  TABLE_SYSTEM_FIELDS,
  type TableAggregation,
  type TableCardSpec,
  type TableDashboardConfig,
  type TableDashboardWidgetConfig,
  type TableDashboardWidgetType,
  type TableDateBucket,
  type TableDateRangePreset,
  type TableFieldType,
  type TableFilterClause,
  type TableFilterControl,
  type TableFilterControlKind,
  type TableFilterGroup,
  type TableFilterOperator,
  type TableFilterValue,
  type TableQuery,
  type TableSystemField,
} from './tables.js';

export type {
  TableCardSpec,
  TableDashboardConfig,
  TableDateRangePreset,
  TableFilterControl,
  TableFilterControlKind,
  TableFilterValue,
} from './tables.js';

// ─── Vocabulary ───────────────────────────────────────────

export const TABLE_CARD_KINDS = ['kpi', 'chart', 'pivot', 'records', 'text'] as const;
export type TableCardKind = TableCardSpec['kind'];

export const TABLE_CARD_CHART_TYPES = ['bar', 'line', 'area', 'pie'] as const;
export type TableCardChartType = (typeof TABLE_CARD_CHART_TYPES)[number];

export const TABLE_CARD_SORTS = ['value_desc', 'value_asc', 'group_asc', 'group_desc'] as const;
export type TableCardSort = (typeof TABLE_CARD_SORTS)[number];

export const TABLE_FILTER_CONTROL_KINDS = ['date_range', 'select', 'user', 'search'] as const;

export const TABLE_DATE_RANGE_PRESETS = [
  'today',
  'last_7_days',
  'last_30_days',
  'this_week',
  'this_month',
  'this_quarter',
  'this_year',
] as const satisfies readonly TableDateRangePreset[];

export const TABLE_CARD_LIMITS = Object.freeze({
  /** Groups an aggregate returns (the server caps it again). */
  groups: 100,
  /** Rows a records card shows per page. */
  records: 100,
  defaultRecords: 20,
  /** Records a drill-down returns per page. */
  drilldown: 50,
  markdown: 100_000,
  fieldIds: 50,
  /** Filter controls on one dashboard. */
  controls: 6,
  targets: 10,
  /** Selected options / people in one control value (the compiler's `in` limit). */
  values: 50,
  search: 200,
  label: 60,
});

/** Clauses one filter group may hold (mirrors the compiler's `MAX_QUERY_CLAUSES`). */
const MAX_GROUP_CLAUSES = 20;

/** One chart point or pivot cell, as returned by the aggregate (`TableAggregateRow` without the value). */
export interface TableCardPoint {
  group: string | number | boolean | null;
  series?: string | number | boolean | null;
}

/**
 * What evaluating a card returns on the wire. `records` pages carry projected
 * records (`TPage` is the transport's record page type).
 */
export type TableCardResult<TPage = unknown> =
  | { kind: 'text'; markdown: string }
  | { kind: 'kpi'; value: number }
  | {
      kind: 'chart' | 'pivot';
      rows: Array<{ group: TableCardPoint['group']; series?: TableCardPoint['series']; value: number }>;
    }
  | { kind: 'records'; page: TPage }
  /** The reader may not see this card's table or a field its query references. */
  | { kind: 'no_access' };

// ─── Small guards ─────────────────────────────────────────

type Ref = { fieldId?: number; systemField?: TableSystemField };
type Dimension = Ref & { dateBucket?: TableDateBucket };

class CardShapeError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isSystemField(value: unknown): value is TableSystemField {
  return typeof value === 'string' && (TABLE_SYSTEM_FIELDS as readonly string[]).includes(value);
}

function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function ref(raw: unknown, label: string): Ref {
  if (!isObject(raw)) throw new CardShapeError(`${label} must be an object`);
  const hasField = raw.fieldId !== undefined;
  const hasSystem = raw.systemField !== undefined;
  if (hasField === hasSystem) throw new CardShapeError(`${label} requires exactly one of fieldId / systemField`);
  if (hasField) {
    if (!isPositiveInt(raw.fieldId)) throw new CardShapeError(`${label} fieldId is invalid`);
    return { fieldId: raw.fieldId };
  }
  if (!isSystemField(raw.systemField)) throw new CardShapeError(`${label} systemField is invalid`);
  return { systemField: raw.systemField };
}

function dimension(raw: unknown, label: string, allowBucket: boolean): Dimension {
  const base = ref(raw, label);
  const bucket = (raw as Record<string, unknown>).dateBucket;
  if (bucket === undefined) return base;
  if (!allowBucket || !(TABLE_DATE_BUCKETS as readonly unknown[]).includes(bucket)) {
    throw new CardShapeError(`${label} dateBucket is invalid`);
  }
  if (base.systemField === 'created_by' || base.systemField === 'updated_by') {
    throw new CardShapeError(`${label} dateBucket requires a date field`);
  }
  return { ...base, dateBucket: bucket as TableDateBucket };
}

function isTimeSystemField(field: TableSystemField | undefined): boolean {
  return field === 'created_at' || field === 'updated_at';
}

function isUserSystemField(field: TableSystemField | undefined): boolean {
  return field === 'created_by' || field === 'updated_by';
}

// ─── Card shape ───────────────────────────────────────────

export type TableCardShapeResult = { ok: true; card: TableCardSpec } | { ok: false; error: string };

function sourceOf(raw: unknown): NonNullable<TableCardSpec['source']> {
  if (!isObject(raw) || !isPositiveInt(raw.tableId)) throw new CardShapeError('source.tableId is required');
  if (raw.query === undefined || raw.query === null) return { tableId: raw.tableId };
  if (!isObject(raw.query)) throw new CardShapeError('source.query must be an object');
  // A card is evaluated, never paged by its author: cursor / limit belong to the reader.
  const { cursor: _cursor, limit: _limit, ...query } = raw.query as TableQuery;
  return { tableId: raw.tableId, query };
}

function aggregateOf(
  raw: unknown,
  options: { groupBy: 'none' | 'optional' | 'required'; series: boolean },
): NonNullable<TableCardSpec['aggregate']> {
  const input = isObject(raw) ? raw : {};
  const operation = (input.operation ?? 'count') as TableAggregation;
  if (!TABLE_AGGREGATIONS.includes(operation))
    throw new CardShapeError(`Unsupported aggregation "${String(operation)}"`);
  const out: NonNullable<TableCardSpec['aggregate']> = { operation };
  if (input.valueFieldId !== undefined && input.valueFieldId !== null) {
    if (!isPositiveInt(input.valueFieldId)) throw new CardShapeError('aggregate.valueFieldId is invalid');
    if (operation !== 'count') out.valueFieldId = input.valueFieldId;
  }
  if (operation !== 'count' && out.valueFieldId === undefined) {
    throw new CardShapeError(`${operation} requires aggregate.valueFieldId`);
  }
  if (options.groupBy === 'none') return out;
  if (input.groupBy !== undefined && input.groupBy !== null) {
    out.groupBy = dimension(input.groupBy, 'aggregate.groupBy', true);
  } else if (options.groupBy === 'required') {
    throw new CardShapeError('aggregate.groupBy is required');
  }
  if (input.series !== undefined && input.series !== null) {
    if (!options.series) throw new CardShapeError('This card has no second dimension');
    if (!out.groupBy) throw new CardShapeError('aggregate.series requires aggregate.groupBy');
    out.series = ref(input.series, 'aggregate.series');
  }
  if (input.sort !== undefined) {
    if (!(TABLE_CARD_SORTS as readonly unknown[]).includes(input.sort))
      throw new CardShapeError('aggregate.sort is invalid');
    out.sort = input.sort as TableCardSort;
  }
  if (input.limit !== undefined) {
    if (
      !Number.isInteger(input.limit) ||
      (input.limit as number) < 1 ||
      (input.limit as number) > TABLE_CARD_LIMITS.groups
    ) {
      throw new CardShapeError(`aggregate.limit must be between 1 and ${TABLE_CARD_LIMITS.groups}`);
    }
    out.limit = input.limit as number;
  }
  return out;
}

function chartOf(raw: unknown, hasSeries: boolean): NonNullable<TableCardSpec['chart']> {
  const input = isObject(raw) ? raw : {};
  const type = (input.type ?? 'bar') as TableCardChartType;
  if (!TABLE_CARD_CHART_TYPES.includes(type)) throw new CardShapeError(`Unsupported chart type "${String(type)}"`);
  const out: NonNullable<TableCardSpec['chart']> = { type };
  // Flags that mean nothing for the chart type are dropped, not stored.
  if (input.stacked === true && hasSeries && type !== 'pie') out.stacked = true;
  if (input.horizontal === true && type === 'bar') out.horizontal = true;
  if (input.donut === true && type === 'pie') out.donut = true;
  if (input.showValues === true) out.showValues = true;
  return out;
}

function displayOf(raw: Record<string, unknown>): Pick<TableCardSpec, 'fieldIds' | 'systemFields' | 'limit'> {
  const out: Pick<TableCardSpec, 'fieldIds' | 'systemFields' | 'limit'> = {};
  if (raw.fieldIds !== undefined) {
    if (
      !Array.isArray(raw.fieldIds) ||
      raw.fieldIds.length > TABLE_CARD_LIMITS.fieldIds ||
      !raw.fieldIds.every(isPositiveInt)
    ) {
      throw new CardShapeError(`fieldIds must hold at most ${TABLE_CARD_LIMITS.fieldIds} field ids`);
    }
    out.fieldIds = [...new Set(raw.fieldIds as number[])];
  }
  if (raw.systemFields !== undefined) {
    if (!Array.isArray(raw.systemFields) || !raw.systemFields.every(isSystemField)) {
      throw new CardShapeError('systemFields is invalid');
    }
    out.systemFields = [...new Set(raw.systemFields as TableSystemField[])];
  }
  if (raw.limit !== undefined) {
    if (
      !Number.isInteger(raw.limit) ||
      (raw.limit as number) < 1 ||
      (raw.limit as number) > TABLE_CARD_LIMITS.records
    ) {
      throw new CardShapeError(`limit must be between 1 and ${TABLE_CARD_LIMITS.records}`);
    }
    out.limit = raw.limit as number;
  }
  return out;
}

/**
 * Validate a card's shape and return a clean copy (unknown keys dropped, flags
 * that mean nothing for the kind removed). Field existence, types and
 * readability are checked by the server against the table's schema.
 */
export function normalizeTableCardSpec(raw: unknown): TableCardShapeResult {
  try {
    if (!isObject(raw)) throw new CardShapeError('card must be an object');
    const kind = raw.kind as TableCardSpec['kind'];
    if (!(TABLE_CARD_KINDS as readonly unknown[]).includes(kind)) {
      throw new CardShapeError(`Unsupported card kind "${String(kind)}"`);
    }
    if (kind === 'text') {
      const markdown = raw.markdown ?? '';
      if (typeof markdown !== 'string') throw new CardShapeError('Text card content must be text');
      if (markdown.length > TABLE_CARD_LIMITS.markdown) {
        throw new CardShapeError(`Text card exceeds ${TABLE_CARD_LIMITS.markdown.toLocaleString('en-US')} characters`);
      }
      return { ok: true, card: { kind, markdown } };
    }
    const source = sourceOf(raw.source);
    if (kind === 'records') return { ok: true, card: { kind, source, ...displayOf(raw) } };
    if (kind === 'kpi') {
      return {
        ok: true,
        card: { kind, source, aggregate: aggregateOf(raw.aggregate, { groupBy: 'none', series: false }) },
      };
    }
    if (kind === 'pivot') {
      return {
        ok: true,
        card: { kind, source, aggregate: aggregateOf(raw.aggregate, { groupBy: 'required', series: true }) },
      };
    }
    const chartType = isObject(raw.chart) ? raw.chart.type : undefined;
    const aggregate = aggregateOf(raw.aggregate, { groupBy: 'optional', series: chartType !== 'pie' });
    return { ok: true, card: { kind, source, aggregate, chart: chartOf(raw.chart, Boolean(aggregate.series)) } };
  } catch (error) {
    if (error instanceof CardShapeError) return { ok: false, error: error.message };
    throw error;
  }
}

/** The stored widget `type` a card implies (the `type` column mirrors `kind` / `chart.type`). */
export function widgetTypeForCard(card: Pick<TableCardSpec, 'kind' | 'chart'>): TableDashboardWidgetType {
  return card.kind === 'chart' ? (card.chart?.type ?? 'bar') : card.kind;
}

/**
 * A stored widget as a card: `config.card` when present, otherwise the legacy
 * flat config (`operation / valueFieldId / groupByFieldId / query / limit /
 * text`) mapped by its `type`. Never fails — a legacy widget without a table
 * yields a card without `source`, which the evaluator reports.
 */
export function legacyWidgetToCard(
  type: TableDashboardWidgetType,
  config: TableDashboardWidgetConfig | null | undefined,
  tableId: number | null | undefined,
): TableCardSpec {
  const legacy: TableDashboardWidgetConfig = isObject(config) ? config : {};
  if (isObject(legacy.card)) return legacy.card;
  if (type === 'text') return { kind: 'text', markdown: typeof legacy.text === 'string' ? legacy.text : '' };
  const source = tableId ? { tableId, ...(isObject(legacy.query) ? { query: legacy.query } : {}) } : undefined;
  if (type === 'records') {
    return { kind: 'records', ...(source ? { source } : {}), ...(legacy.limit ? { limit: legacy.limit } : {}) };
  }
  const operation = legacy.operation && TABLE_AGGREGATIONS.includes(legacy.operation) ? legacy.operation : 'count';
  const aggregate: NonNullable<TableCardSpec['aggregate']> = {
    operation,
    ...(operation !== 'count' && legacy.valueFieldId ? { valueFieldId: legacy.valueFieldId } : {}),
  };
  if (type === 'kpi') return { kind: 'kpi', ...(source ? { source } : {}), aggregate };
  const grouped = {
    ...aggregate,
    ...(legacy.groupByFieldId ? { groupBy: { fieldId: legacy.groupByFieldId } } : {}),
    ...(legacy.limit ? { limit: legacy.limit } : {}),
  };
  if (type === 'pivot') return { kind: 'pivot', ...(source ? { source } : {}), aggregate: grouped };
  return { kind: 'chart', ...(source ? { source } : {}), aggregate: grouped, chart: { type } };
}

/** Every field id a card's *predicate* depends on (query, sort, grouping, aggregate) — not its display columns. */
export function cardQueryFieldIds(card: TableCardSpec): number[] {
  const ids = new Set<number>();
  const add = (value: unknown) => {
    if (isPositiveInt(value)) ids.add(value);
  };
  const query = card.source?.query;
  for (const group of [query?.where, ...(query?.filters ?? [])]) {
    for (const clause of group?.clauses ?? []) add(clause.fieldId);
  }
  for (const sort of query?.sort ?? []) add(sort.fieldId);
  add(query?.groupBy?.fieldId);
  add(card.aggregate?.valueFieldId);
  add(card.aggregate?.groupBy?.fieldId);
  add(card.aggregate?.series?.fieldId);
  return [...ids];
}

/**
 * A card as a restricted reader may see it. `readable` = the field ids the
 * reader may reference on the card's table (null = every field; undefined =
 * the table itself is not readable). A card whose predicate touches a field
 * the reader cannot read is withheld entirely (`null`) — its constants would
 * otherwise disclose hidden values; display columns the reader cannot read are
 * simply dropped.
 */
export function trimCardForReader(
  card: TableCardSpec,
  readable: ReadonlySet<number> | null | undefined,
): TableCardSpec | null {
  if (card.kind === 'text') return card;
  if (readable === undefined) return null;
  if (readable === null) return card;
  if (cardQueryFieldIds(card).some((id) => !readable.has(id))) return null;
  if (!card.fieldIds) return card;
  return { ...card, fieldIds: card.fieldIds.filter((id) => readable.has(id)) };
}

// ─── Filter controls ──────────────────────────────────────

const CONTROL_ID = /^[A-Za-z0-9_-]{1,40}$/;

export type TableFilterControlShapeResult = { ok: true; control: TableFilterControl } | { ok: false; error: string };

function targetAllowedForKind(kind: TableFilterControlKind, target: Ref): boolean {
  if (target.systemField === undefined) return true;
  if (kind === 'date_range') return isTimeSystemField(target.systemField);
  if (kind === 'user') return isUserSystemField(target.systemField);
  return false;
}

/**
 * Validate one control's shape. Whether a target field exists, belongs to the
 * dashboard's Base and has a type the kind can filter is the server's check
 * (it has the schema).
 */
export function normalizeFilterControl(raw: unknown): TableFilterControlShapeResult {
  try {
    if (!isObject(raw)) throw new CardShapeError('Filter control must be an object');
    if (typeof raw.id !== 'string' || !CONTROL_ID.test(raw.id)) {
      throw new CardShapeError('Filter control id must be 1-40 letters, digits, - or _');
    }
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!label || label.length > TABLE_CARD_LIMITS.label) {
      throw new CardShapeError(`Filter control label must be 1-${TABLE_CARD_LIMITS.label} characters`);
    }
    const kind = raw.kind as TableFilterControlKind;
    if (!(TABLE_FILTER_CONTROL_KINDS as readonly unknown[]).includes(kind)) {
      throw new CardShapeError(`Unsupported filter control kind "${String(kind)}"`);
    }
    if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > TABLE_CARD_LIMITS.targets) {
      throw new CardShapeError(`A filter control needs 1-${TABLE_CARD_LIMITS.targets} targets`);
    }
    const seen = new Set<string>();
    const dateTables = new Set<number>();
    const targets = raw.targets.map((entry) => {
      if (!isObject(entry) || !isPositiveInt(entry.tableId)) throw new CardShapeError('Each target needs a tableId');
      const target = { tableId: entry.tableId, ...ref(entry, 'Filter target') };
      if (!targetAllowedForKind(kind, target)) {
        throw new CardShapeError(`A ${kind} control cannot filter ${target.systemField}`);
      }
      const key = `${target.tableId}:${target.fieldId ?? target.systemField}`;
      if (seen.has(key)) throw new CardShapeError('Filter targets must be distinct');
      seen.add(key);
      // A flat filter group cannot say "this range on field A or on field B".
      if (kind === 'date_range') {
        if (dateTables.has(target.tableId)) throw new CardShapeError('A date range filters one field per table');
        dateTables.add(target.tableId);
      }
      return target;
    });
    const control: TableFilterControl = { id: raw.id, label, kind, targets };
    if (raw.defaultValue !== undefined && raw.defaultValue !== null) {
      const value = normalizeFilterValue(kind, raw.defaultValue);
      if (value) control.defaultValue = value;
    }
    return { ok: true, control };
  } catch (error) {
    if (error instanceof CardShapeError) return { ok: false, error: error.message };
    throw error;
  }
}

export type TableDashboardConfigShapeResult =
  | { ok: true; config: Required<TableDashboardConfig> }
  | { ok: false; error: string };

/** A dashboard's `config`: `{version: 1, filters}` with ≤ 6 uniquely-identified controls. */
export function normalizeDashboardConfig(raw: unknown): TableDashboardConfigShapeResult {
  if (raw === undefined || raw === null) return { ok: true, config: { version: 1, filters: [] } };
  if (!isObject(raw)) return { ok: false, error: 'Dashboard config must be an object' };
  const input = raw.filters ?? [];
  if (!Array.isArray(input) || input.length > TABLE_CARD_LIMITS.controls) {
    return { ok: false, error: `A dashboard has at most ${TABLE_CARD_LIMITS.controls} filters` };
  }
  const filters: TableFilterControl[] = [];
  for (const entry of input) {
    const result = normalizeFilterControl(entry);
    if (!result.ok) return result;
    if (filters.some((control) => control.id === result.control.id)) {
      return { ok: false, error: `Duplicate filter id "${result.control.id}"` };
    }
    filters.push(result.control);
  }
  return { ok: true, config: { version: 1, filters } };
}

function stringList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (!value || value.length > 200 || out.includes(value)) continue;
    out.push(value);
    if (out.length === max) break;
  }
  return out;
}

/**
 * A viewer's value for a control of `kind`, cleaned; null = no constraint
 * (empty, malformed or for another kind — ignored rather than an error, so a
 * stale value never breaks a dashboard).
 */
export function normalizeFilterValue(kind: TableFilterControlKind, raw: unknown): TableFilterValue | null {
  if (!isObject(raw) || raw.kind !== kind) return null;
  switch (kind) {
    case 'date_range': {
      if ((TABLE_DATE_RANGE_PRESETS as readonly unknown[]).includes(raw.preset)) {
        return { kind, preset: raw.preset as TableDateRangePreset };
      }
      const from = isDay(raw.from) ? raw.from : undefined;
      const to = isDay(raw.to) ? raw.to : undefined;
      if (!from && !to) return null;
      if (from && to && from > to) return { kind, from: to, to: from };
      return { kind, ...(from ? { from } : {}), ...(to ? { to } : {}) };
    }
    case 'select': {
      const values = stringList(raw.values, TABLE_CARD_LIMITS.values);
      return values.length ? { kind, values } : null;
    }
    case 'user': {
      const userIds = stringList(raw.userIds, TABLE_CARD_LIMITS.values);
      return userIds.length ? { kind, userIds } : null;
    }
    case 'search': {
      const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, TABLE_CARD_LIMITS.search) : '';
      return text ? { kind, text } : null;
    }
  }
}

// ─── Calendar arithmetic (YYYY-MM-DD, zone-free) ──────────

function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** First day of the month `months` after `day`'s month. */
function monthStart(day: string, months = 0): string {
  const date = new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

/** The last calendar day of the bucket starting at `start` (inclusive bounds). */
export function bucketRange(bucket: TableDateBucket, start: string): { from: string; to: string } {
  switch (bucket) {
    case 'day':
      return { from: start, to: start };
    case 'week':
      return { from: start, to: shiftDay(start, 6) };
    case 'month':
      return { from: start, to: shiftDay(monthStart(start, 1), -1) };
    case 'quarter':
      return { from: start, to: shiftDay(monthStart(start, 3), -1) };
    case 'year':
      return { from: start, to: `${start.slice(0, 4)}-12-31` };
  }
}

/**
 * Inclusive calendar-day bounds of a date-range value, "today" taken in
 * `timeZone` at `now`. Weeks start on Monday (same as `$week_start` and the
 * aggregate's week buckets).
 */
export function dateRangeBounds(
  value: Extract<TableFilterValue, { kind: 'date_range' }>,
  timeZone: string,
  now: Date = new Date(),
): { from?: string; to?: string } {
  if (!value.preset) return { ...(value.from ? { from: value.from } : {}), ...(value.to ? { to: value.to } : {}) };
  const today = expandDateToken('$today', now, timeZone) ?? now.toISOString().slice(0, 10);
  switch (value.preset) {
    case 'today':
      return { from: today, to: today };
    case 'last_7_days':
      return { from: shiftDay(today, -6), to: today };
    case 'last_30_days':
      return { from: shiftDay(today, -29), to: today };
    case 'this_week': {
      const weekday = (new Date(`${today}T00:00:00.000Z`).getUTCDay() + 6) % 7;
      return bucketRange('week', shiftDay(today, -weekday));
    }
    case 'this_month':
      return bucketRange('month', monthStart(today));
    case 'this_quarter': {
      const month = Number(today.slice(5, 7)) - 1;
      return bucketRange('quarter', monthStart(`${today.slice(0, 4)}-01-01`, month - (month % 3)));
    }
    case 'this_year':
      return bucketRange('year', `${today.slice(0, 4)}-01-01`);
  }
}

// ─── Filter values → predicates ───────────────────────────

/** Resolves a target field's value type (formula → its result type); undefined = unknown. */
export type TableFieldTypeOf = (target: { tableId?: number; fieldId: number }) => TableFieldType | undefined;

function clause(target: Ref, operator: TableFilterOperator, value?: unknown): TableFilterClause {
  return target.systemField !== undefined
    ? { systemField: target.systemField, operator, ...(value === undefined ? {} : { value }) }
    : { fieldId: target.fieldId!, operator, ...(value === undefined ? {} : { value }) };
}

/**
 * The predicates one control value adds, per table it targets. Within a table
 * the targets are alternatives (OR) — "status is X on any of these fields";
 * a date range has one target per table and is a `from ≤ x ≤ to` AND pair.
 * Values: `select` = option ids (`in`, or `contains` each on multi-selects);
 * `user` = user ids, `$me` allowed (resolved by the compiler to the reader);
 * `search` = `contains` text.
 */
export function filterValueToGroups(
  control: TableFilterControl,
  value: unknown,
  timeZone: string,
  options: { now?: Date; fieldType?: TableFieldTypeOf } = {},
): Array<{ tableId: number; group: TableFilterGroup }> {
  const normalized = normalizeFilterValue(control.kind, value);
  if (!normalized) return [];
  const byTable = new Map<number, Array<TableFilterControl['targets'][number]>>();
  for (const target of control.targets) {
    byTable.set(target.tableId, [...(byTable.get(target.tableId) ?? []), target]);
  }
  const typeOf = (target: TableFilterControl['targets'][number]) =>
    target.fieldId !== undefined
      ? options.fieldType?.({ tableId: target.tableId, fieldId: target.fieldId })
      : undefined;
  const out: Array<{ tableId: number; group: TableFilterGroup }> = [];
  for (const [tableId, targets] of byTable) {
    const clauses: TableFilterClause[] = [];
    let combinator: TableFilterGroup['combinator'] = 'or';
    switch (normalized.kind) {
      case 'date_range': {
        const bounds = dateRangeBounds(normalized, timeZone, options.now);
        const target = targets[0]!;
        if (bounds.from) clauses.push(clause(target, 'gte', bounds.from));
        if (bounds.to) clauses.push(clause(target, 'lte', bounds.to));
        combinator = 'and';
        break;
      }
      case 'select':
        for (const target of targets) {
          if (typeOf(target) === 'multi_select') {
            for (const option of normalized.values) clauses.push(clause(target, 'contains', option));
          } else {
            clauses.push(clause(target, 'in', normalized.values));
          }
        }
        break;
      case 'user':
        for (const target of targets) {
          if (target.systemField === undefined && typeOf(target) === 'multi_user') {
            for (const userId of normalized.userIds) clauses.push(clause(target, 'contains', userId));
          } else {
            clauses.push(clause(target, 'in', normalized.userIds));
          }
        }
        break;
      case 'search':
        for (const target of targets) clauses.push(clause(target, 'contains', normalized.text));
        break;
    }
    if (clauses.length > 0) out.push({ tableId, group: { combinator, clauses } });
  }
  return out;
}

/**
 * The groups every control adds to a card on `tableId`. A value present in
 * `values` (even null) is the viewer's choice; an absent one falls back to the
 * control's default.
 */
export function filterGroupsForTable(
  controls: readonly TableFilterControl[],
  values: Readonly<Record<string, unknown>> | undefined,
  tableId: number,
  timeZone: string,
  options: { now?: Date; fieldType?: TableFieldTypeOf } = {},
): TableFilterGroup[] {
  return controls.flatMap((control) => {
    const chosen = values !== undefined && Object.prototype.hasOwnProperty.call(values, control.id);
    const value = chosen ? values[control.id] : control.defaultValue;
    return filterValueToGroups(control, value, timeZone, options)
      .filter((entry) => entry.tableId === tableId)
      .map((entry) => entry.group);
  });
}

/**
 * Fold groups into as few as the query allows: every AND group and every
 * single-clause group joins one AND group (≤ 20 clauses each); only real OR
 * groups stay separate. Empty groups are dropped.
 */
export function mergeFilterGroups(groups: readonly TableFilterGroup[]): TableFilterGroup[] {
  const ors: TableFilterGroup[] = [];
  const ands: TableFilterGroup[] = [];
  let current: TableFilterClause[] = [];
  for (const group of groups) {
    if (group.clauses.length === 0) continue;
    if (group.combinator === 'or' && group.clauses.length > 1) {
      ors.push(group);
      continue;
    }
    for (const entry of group.clauses) {
      if (current.length === MAX_GROUP_CLAUSES) {
        ands.push({ combinator: 'and', clauses: current });
        current = [];
      }
      current.push(entry);
    }
  }
  if (current.length > 0) ands.push({ combinator: 'and', clauses: current });
  return [...ands, ...ors];
}

/**
 * Controls as a restricted reader may see them: targets on tables the reader
 * cannot read, or on fields outside `readableFor(tableId)`, are removed; a
 * control left with no target is dropped. `readableFor` returns undefined for an
 * unreadable table and null for "every field". System fields are readable
 * wherever the table is.
 */
export function trimFilterControlsForReader(
  controls: readonly TableFilterControl[],
  readableFor: (tableId: number) => ReadonlySet<number> | null | undefined,
): TableFilterControl[] {
  const out: TableFilterControl[] = [];
  for (const control of controls) {
    const targets = control.targets.filter((target) => {
      const readable = readableFor(target.tableId);
      if (readable === undefined) return false;
      return target.fieldId === undefined || readable === null || readable.has(target.fieldId);
    });
    if (targets.length > 0) out.push(targets.length === control.targets.length ? control : { ...control, targets });
  }
  return out;
}

// ─── Drill-down ───────────────────────────────────────────

/** Types whose stored value may be a JSON array (the aggregate's group key is then the array's text). */
const ARRAY_VALUED: ReadonlySet<TableFieldType> = new Set([
  'multi_select',
  'multi_user',
  'attachment',
  'lookup',
  'relation',
]);

function pointValue(raw: TableCardPoint['group'], type: TableFieldType | undefined): unknown {
  if (type === 'number') return typeof raw === 'number' ? raw : Number(raw);
  if (type === 'boolean') return raw === true || raw === 'true';
  if (type && ARRAY_VALUED.has(type) && typeof raw === 'string' && raw.startsWith('[')) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  if (type === 'relation' && typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return typeof raw === 'string' ? raw : String(raw);
}

function dimensionClauses(
  dim: Dimension,
  raw: TableCardPoint['group'],
  typeOf?: TableFieldTypeOf,
): TableFilterClause[] {
  if (raw === null || raw === undefined) return [clause(dim, 'is_empty')];
  const bucket = isTimeSystemField(dim.systemField) ? (dim.dateBucket ?? 'day') : dim.dateBucket;
  if (bucket) {
    const start = String(raw);
    if (!isDay(start)) return [clause(dim, 'eq', start)];
    const range = bucketRange(bucket, start);
    return [clause(dim, 'gte', range.from), clause(dim, 'lte', range.to)];
  }
  if (dim.systemField !== undefined) return [clause(dim, 'eq', String(raw))];
  return [clause(dim, 'eq', pointValue(raw, typeOf?.({ fieldId: dim.fieldId! })))];
}

/**
 * The predicate selecting the records behind one point of a chart / pivot
 * card: its group (a date bucket becomes that bucket's calendar-day range — the
 * keys are local days in the zone the card was evaluated in, so the drill query
 * must be evaluated in the same zone) and, when the card has one, its series.
 * `fieldType` turns the aggregate's text keys back into typed values (numbers,
 * booleans, multi-value arrays). An empty group ("no value") becomes `is_empty`.
 */
export function drilldownFilters(
  spec: TableCardSpec,
  point: TableCardPoint,
  fieldType?: TableFieldTypeOf,
): TableFilterGroup {
  const clauses: TableFilterClause[] = [];
  const groupBy = spec.aggregate?.groupBy;
  if (groupBy && (spec.kind === 'chart' || spec.kind === 'pivot')) {
    clauses.push(...dimensionClauses(groupBy, point.group, fieldType));
    if (spec.aggregate?.series && point.series !== undefined) {
      clauses.push(...dimensionClauses(spec.aggregate.series, point.series, fieldType));
    }
  }
  return { combinator: 'and', clauses };
}
