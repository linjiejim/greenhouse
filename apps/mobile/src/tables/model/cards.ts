/**
 * Aggregate cards (dashboard widgets, app kpi / chart / pivot cards) on the
 * phone — pure (root vitest: ./cards.test.ts). A port of the web's
 * `components/table-cards/{card-labels,chart-model}.ts` and the pivot model in
 * `pivot-card.tsx` (those import the web i18n and React; the rules are small):
 *
 *  - the aggregate answers raw keys — option ids, user ids, `YYYY-MM-DD` bucket
 *    starts, JSON text for multi-values — and `dimensionLabel` reads them;
 *  - a chart is one dataset over the groups, or one per series key (missing
 *    cells 0), at most eight coloured entities (the smallest fold into "Other");
 *  - a pivot is rows = groups × columns = series, with totals only where adding
 *    up means something (count, sum).
 *
 * The result is the chat chart block's `ChartData` (src/shared/rich-output), so
 * the same renderer draws a card and a chart fence. Area / stacked / horizontal
 * come back as display hints (`ChartHints`) the renderer may honour.
 */

import type { ChartData } from '../../shared/rich-output';
import type { TableAggregation, TableCardSpec, TableDateBucket, TableSystemField } from '../../shared/tables';
import { effectiveType, fieldConfig, formatFieldNumber, type FieldLike } from './fields';

export type CardKey = string | number | boolean | null;
export type CardDimension = { fieldId?: number; systemField?: TableSystemField; dateBucket?: TableDateBucket };
export interface AggregateRow {
  group: CardKey;
  series?: CardKey;
  value: number;
}

/** The words a card needs, in the reader's language. */
export interface CardCopy {
  allRecords: string;
  empty: string;
  other: string;
  /** A pivot's totals row / column. */
  total: string;
  yes: string;
  no: string;
  weekOf: (date: string) => string;
  quarter: (year: string, quarter: number) => string;
  /** "Records" / "Sum of Amount". */
  valueCaption: (operation: TableAggregation, field: string) => string;
  systemField: (field: TableSystemField) => string;
}

export interface CardLabelContext {
  fieldsById: ReadonlyMap<number, FieldLike>;
  userLabel: (id: string) => string | undefined;
  copy: CardCopy;
  /** BCP-47 tag. */
  locale: string;
}

/** Most coloured entities a chart shows before folding the rest into "Other". */
export const CHART_SLOT_COUNT = 8;

function dayFormat(locale: string, options: Intl.DateTimeFormatOptions): (day: string) => string {
  return (day) => {
    const date = new Date(`${day}T00:00:00.000Z`);
    if (Number.isNaN(date.valueOf())) return day;
    try {
      // bucket keys are calendar days, not instants: format them in UTC
      return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(date);
    } catch {
      return day;
    }
  };
}

function bucketOf(dim: CardDimension): TableDateBucket | undefined {
  if (dim.dateBucket) return dim.dateBucket;
  return dim.systemField === 'created_at' || dim.systemField === 'updated_at' ? 'day' : undefined;
}

function bucketLabel(bucket: TableDateBucket, key: string, ctx: CardLabelContext): string {
  const day = dayFormat(ctx.locale, { year: 'numeric', month: 'short', day: 'numeric' });
  switch (bucket) {
    case 'day':
      return day(key);
    case 'week':
      return ctx.copy.weekOf(day(key));
    case 'month':
      return dayFormat(ctx.locale, { year: 'numeric', month: 'short' })(key);
    case 'quarter':
      return ctx.copy.quarter(key.slice(0, 4), Math.floor((Number(key.slice(5, 7)) - 1) / 3) + 1);
    case 'year':
      return key.slice(0, 4);
  }
}

function arrayKey(key: string): unknown[] | null {
  if (!key.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(key) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The name of a dimension itself (the field, or the system column). */
export function dimensionTitle(dim: CardDimension | undefined, ctx: CardLabelContext): string {
  if (!dim) return '';
  if (dim.systemField) return ctx.copy.systemField(dim.systemField);
  return (dim.fieldId === undefined ? undefined : ctx.fieldsById.get(dim.fieldId)?.name) ?? '';
}

/** One group / series key as a person reads it. */
export function dimensionLabel(dim: CardDimension | undefined, key: CardKey, ctx: CardLabelContext): string {
  if (!dim) return ctx.copy.allRecords;
  if (key === null || key === undefined || key === '') return ctx.copy.empty;
  const text = String(key);
  const bucket = bucketOf(dim);
  if (bucket) return bucketLabel(bucket, text, ctx);
  if (dim.systemField) return ctx.userLabel(text) ?? text;
  const field = dim.fieldId === undefined ? undefined : ctx.fieldsById.get(dim.fieldId);
  if (!field) return text;
  const config = fieldConfig(field);
  const optionLabel = (id: unknown) => config.options?.find((option) => option.id === id)?.label ?? String(id);
  const userLabel = (id: unknown) => ctx.userLabel(String(id)) ?? String(id);
  switch (effectiveType(field)) {
    case 'single_select':
      return optionLabel(text);
    case 'multi_select':
      return (arrayKey(text) ?? [text]).map(optionLabel).join(', ');
    case 'user':
      return userLabel(text);
    case 'multi_user':
      return (arrayKey(text) ?? [text]).map(userLabel).join(', ');
    case 'boolean':
      return text === 'true' ? ctx.copy.yes : ctx.copy.no;
    case 'date':
      return dayFormat(ctx.locale, { year: 'numeric', month: 'short', day: 'numeric' })(text);
    case 'number':
    case 'rollup': {
      const value = Number(text);
      return Number.isFinite(value) ? formatCardNumber(value, ctx.locale) : text;
    }
    default:
      return text;
  }
}

/**
 * The colour slot of a key: a select option's position in its field, `true`
 * before `false`, otherwise the key's position among `keys` (sorted).
 */
export function dimensionSlot(
  dim: CardDimension | undefined,
  key: CardKey,
  keys: readonly CardKey[],
  ctx: Pick<CardLabelContext, 'fieldsById'>,
): number {
  const field = dim?.fieldId === undefined ? undefined : ctx.fieldsById.get(dim.fieldId);
  if (field && (field.type === 'single_select' || field.type === 'multi_select') && key !== null) {
    const index = (fieldConfig(field).options ?? []).findIndex((option) => option.id === key);
    if (index >= 0) return index;
  }
  if (field?.type === 'boolean') return key === 'true' || key === true ? 0 : 1;
  const sorted = [...new Set(keys.map((entry) => (entry === null ? '\u0000' : String(entry))))].sort();
  return Math.max(0, sorted.indexOf(key === null ? '\u0000' : String(key)));
}

/** A number as a card shows it: grouping, at most two decimals. */
export function formatCardNumber(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  } catch {
    return formatFieldNumber(Math.round(value * 100) / 100, locale);
  }
}

/** The caption of the measured value ("Records", "Sum of Amount"). */
export function valueCaption(card: TableCardSpec, ctx: CardLabelContext): string {
  const operation = card.aggregate?.operation ?? 'count';
  const field = card.aggregate?.valueFieldId ? ctx.fieldsById.get(card.aggregate.valueFieldId) : undefined;
  return ctx.copy.valueCaption(operation, field?.name ?? '—');
}

/** How a card asks its chart to look beyond `ChartData.type` (honoured where the renderer can). */
export interface ChartHints {
  area: boolean;
  stacked: boolean;
  horizontal: boolean;
  showValues: boolean;
}

export interface ChartModel {
  data: ChartData;
  hints: ChartHints;
}

const keyOf = (key: CardKey | undefined) =>
  key === null || key === undefined ? '\u0000null' : `${typeof key}:${String(key)}`;

function unique(keys: CardKey[]): CardKey[] {
  const seen = new Set<string>();
  return keys.filter((key) => {
    const id = keyOf(key);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function buildChartModel(card: TableCardSpec, rows: readonly AggregateRow[], ctx: CardLabelContext): ChartModel {
  const chartType = card.chart?.type ?? 'bar';
  const groupDim = card.aggregate?.groupBy;
  const seriesDim = card.aggregate?.series;
  const isPie = chartType === 'pie';
  const type: ChartData['type'] = isPie
    ? card.chart?.donut
      ? 'doughnut'
      : 'pie'
    : chartType === 'area'
      ? 'line'
      : chartType;
  const hints: ChartHints = {
    area: chartType === 'area',
    stacked: card.chart?.stacked === true,
    horizontal: card.chart?.horizontal === true,
    showValues: card.chart?.showValues === true,
  };
  const other = ctx.copy.other;

  if (!seriesDim) {
    let groups: Array<{ key: CardKey; value: number; other?: true }> = rows.map((row) => ({
      key: row.group,
      value: row.value,
    }));
    if (isPie && groups.length > CHART_SLOT_COUNT) {
      const ranked = [...groups].sort((left, right) => right.value - left.value);
      const kept = new Set(ranked.slice(0, CHART_SLOT_COUNT - 1).map((group) => keyOf(group.key)));
      const rest = groups.filter((group) => !kept.has(keyOf(group.key)));
      groups = [
        ...groups.filter((group) => kept.has(keyOf(group.key))),
        { key: null, value: rest.reduce((sum, group) => sum + group.value, 0), other: true },
      ];
    }
    return {
      data: {
        type,
        labels: groups.map((group) => (group.other ? other : dimensionLabel(groupDim, group.key, ctx))),
        datasets: [{ label: valueCaption(card, ctx), data: groups.map((group) => group.value) }],
      },
      hints,
    };
  }

  const groupKeys = unique(rows.map((row) => row.group));
  const totals = new Map<string, { key: CardKey; total: number }>();
  for (const row of rows) {
    const key = row.series ?? null;
    const entry = totals.get(keyOf(key)) ?? { key, total: 0 };
    entry.total += row.value;
    totals.set(keyOf(key), entry);
  }
  const allSeries = [...totals.values()].map((entry) => entry.key);
  let shown = allSeries;
  let folded: Set<string> | null = null;
  if (allSeries.length > CHART_SLOT_COUNT) {
    const ranked = [...totals.values()].sort((left, right) => right.total - left.total);
    shown = ranked.slice(0, CHART_SLOT_COUNT - 1).map((entry) => entry.key);
    folded = new Set(ranked.slice(CHART_SLOT_COUNT - 1).map((entry) => keyOf(entry.key)));
  }
  shown = [...shown].sort(
    (left, right) => dimensionSlot(seriesDim, left, allSeries, ctx) - dimensionSlot(seriesDim, right, allSeries, ctx),
  );
  const cell = new Map(rows.map((row) => [`${keyOf(row.group)}|${keyOf(row.series ?? null)}`, row.value]));
  const datasets = shown.map((series) => ({
    label: dimensionLabel(seriesDim, series, ctx),
    data: groupKeys.map((group) => cell.get(`${keyOf(group)}|${keyOf(series)}`) ?? 0),
  }));
  if (folded) {
    datasets.push({
      label: other,
      data: groupKeys.map((group) =>
        rows
          .filter((row) => keyOf(row.group) === keyOf(group) && folded!.has(keyOf(row.series ?? null)))
          .reduce((sum, row) => sum + row.value, 0),
      ),
    });
  }
  return {
    data: { type, labels: groupKeys.map((key) => dimensionLabel(groupDim, key, ctx)), datasets },
    hints,
  };
}

export interface PivotModel {
  rows: Array<{ key: CardKey; label: string }>;
  /** Empty when the card has no series (one value column). */
  columns: Array<{ key: CardKey; label: string }>;
  value(row: CardKey, column?: CardKey): number | undefined;
  /** Row / column / grand totals — only for count and sum with a series. */
  totals: { rows: Map<string, number>; columns: Map<string, number>; grand: number } | null;
  rowKey(key: CardKey): string;
}

export function buildPivotModel(card: TableCardSpec, rows: readonly AggregateRow[], ctx: CardLabelContext): PivotModel {
  const groupDim = card.aggregate?.groupBy;
  const seriesDim = card.aggregate?.series;
  const rowKeys: CardKey[] = [];
  const seenRows = new Set<string>();
  const columnKeys: CardKey[] = [];
  const seenColumns = new Set<string>();
  const cells = new Map<string, number>();
  for (const row of rows) {
    if (!seenRows.has(keyOf(row.group))) {
      seenRows.add(keyOf(row.group));
      rowKeys.push(row.group);
    }
    if (seriesDim && !seenColumns.has(keyOf(row.series))) {
      seenColumns.add(keyOf(row.series));
      columnKeys.push(row.series ?? null);
    }
    cells.set(`${keyOf(row.group)}|${seriesDim ? keyOf(row.series) : ''}`, row.value);
  }
  columnKeys.sort(
    (left, right) => dimensionSlot(seriesDim, left, columnKeys, ctx) - dimensionSlot(seriesDim, right, columnKeys, ctx),
  );
  const operation = card.aggregate?.operation ?? 'count';
  let totals: PivotModel['totals'] = null;
  if ((operation === 'count' || operation === 'sum') && seriesDim) {
    const rowTotals = new Map<string, number>();
    const columnTotals = new Map<string, number>();
    let grand = 0;
    for (const row of rows) {
      rowTotals.set(keyOf(row.group), (rowTotals.get(keyOf(row.group)) ?? 0) + row.value);
      columnTotals.set(keyOf(row.series), (columnTotals.get(keyOf(row.series)) ?? 0) + row.value);
      grand += row.value;
    }
    totals = { rows: rowTotals, columns: columnTotals, grand };
  }
  return {
    rows: rowKeys.map((key) => ({ key, label: dimensionLabel(groupDim, key, ctx) })),
    columns: columnKeys.map((key) => ({ key, label: dimensionLabel(seriesDim, key, ctx) })),
    value: (row, column) => cells.get(`${keyOf(row)}|${seriesDim ? keyOf(column) : ''}`),
    totals,
    rowKey: keyOf,
  };
}
