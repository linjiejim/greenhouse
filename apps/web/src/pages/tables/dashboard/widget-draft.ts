/**
 * The widget editor's form state and its two-way mapping to a `TableCardSpec`.
 * Kept pure so the editor stays a thin view and the mapping is unit-tested; the
 * shape check itself is the shared `normalizeTableCardSpec` (the server runs
 * the same function, then checks the schema).
 */

import type { TableCardChartType, TableCardKind, TableCardSort } from '@greenhouse/types/table-cards';
import type {
  TableAggregation,
  TableCardSpec,
  TableDateBucket,
  TableFilterGroup,
  TableQuery,
  TableSystemField,
} from '@greenhouse/types/tables';
import { TABLE_SYSTEM_FIELDS } from '@greenhouse/types/tables';

export interface WidgetDraft {
  title: string;
  kind: TableCardKind;
  tableId: number | '';
  chartType: TableCardChartType;
  operation: TableAggregation;
  valueFieldId: number | '';
  /** `''` | `f:<fieldId>` | `s:<systemField>` */
  groupBy: string;
  dateBucket: TableDateBucket | '';
  series: string;
  sort: TableCardSort | '';
  limit: number | '';
  stacked: boolean;
  horizontal: boolean;
  donut: boolean;
  showValues: boolean;
  where: TableFilterGroup | null;
  /** The rest of the card's query (sort, filters, search — e.g. set by an Agent plan), kept as is. */
  otherQuery: Omit<TableQuery, 'where' | 'cursor' | 'limit'>;
  fieldIds: number[];
  systemFields: TableSystemField[];
  rows: number | '';
  markdown: string;
}

type Ref = { fieldId?: number; systemField?: TableSystemField };

export function refKey(ref: Ref | undefined): string {
  if (!ref) return '';
  if (ref.systemField) return `s:${ref.systemField}`;
  return ref.fieldId ? `f:${ref.fieldId}` : '';
}

export function refFromKey(key: string): Ref | undefined {
  if (key.startsWith('f:')) {
    const fieldId = Number(key.slice(2));
    return Number.isInteger(fieldId) && fieldId > 0 ? { fieldId } : undefined;
  }
  if (key.startsWith('s:')) {
    const systemField = key.slice(2) as TableSystemField;
    return TABLE_SYSTEM_FIELDS.includes(systemField) ? { systemField } : undefined;
  }
  return undefined;
}

export function emptyDraft(tableId: number | ''): WidgetDraft {
  return {
    title: '',
    kind: 'kpi',
    tableId,
    chartType: 'bar',
    operation: 'count',
    valueFieldId: '',
    groupBy: '',
    dateBucket: '',
    series: '',
    sort: '',
    limit: '',
    stacked: false,
    horizontal: false,
    donut: false,
    showValues: false,
    where: null,
    otherQuery: {},
    fieldIds: [],
    systemFields: [],
    rows: '',
    markdown: '',
  };
}

export function draftFromCard(card: TableCardSpec, title: string, fallbackTableId: number | ''): WidgetDraft {
  const aggregate = card.aggregate;
  return {
    ...emptyDraft(card.source?.tableId ?? fallbackTableId),
    title,
    kind: card.kind,
    chartType: card.chart?.type ?? 'bar',
    operation: aggregate?.operation ?? 'count',
    valueFieldId: aggregate?.valueFieldId ?? '',
    groupBy: refKey(aggregate?.groupBy),
    dateBucket: aggregate?.groupBy?.dateBucket ?? '',
    series: refKey(aggregate?.series),
    sort: aggregate?.sort ?? '',
    limit: aggregate?.limit ?? '',
    stacked: Boolean(card.chart?.stacked),
    horizontal: Boolean(card.chart?.horizontal),
    donut: Boolean(card.chart?.donut),
    showValues: Boolean(card.chart?.showValues),
    where: card.source?.query?.where ?? null,
    otherQuery: (({ where: _where, ...rest }) => rest)(card.source?.query ?? {}),
    fieldIds: card.fieldIds ?? [],
    systemFields: card.systemFields ?? [],
    rows: card.limit ?? '',
    markdown: card.markdown ?? '',
  };
}

/**
 * The card a draft describes. Settings the kind does not use are left out;
 * `where` must already be complete (the editor checks with `completedFilterGroup`).
 * The result still goes through `normalizeTableCardSpec` before saving.
 */
export function cardFromDraft(draft: WidgetDraft, where: TableFilterGroup | undefined): TableCardSpec {
  if (draft.kind === 'text') return { kind: 'text', markdown: draft.markdown };
  const query = { ...draft.otherQuery, ...(where ? { where } : {}) };
  const source: NonNullable<TableCardSpec['source']> = {
    tableId: Number(draft.tableId),
    ...(Object.keys(query).length > 0 ? { query } : {}),
  };
  if (draft.kind === 'records') {
    return {
      kind: 'records',
      source,
      ...(draft.fieldIds.length ? { fieldIds: draft.fieldIds } : {}),
      ...(draft.systemFields.length ? { systemFields: draft.systemFields } : {}),
      ...(draft.rows ? { limit: Number(draft.rows) } : {}),
    };
  }
  const aggregate: NonNullable<TableCardSpec['aggregate']> = {
    operation: draft.operation,
    ...(draft.operation !== 'count' && draft.valueFieldId ? { valueFieldId: Number(draft.valueFieldId) } : {}),
  };
  if (draft.kind === 'kpi') return { kind: 'kpi', source, aggregate };
  const groupBy = refFromKey(draft.groupBy);
  const series = draft.kind === 'chart' && draft.chartType === 'pie' ? undefined : refFromKey(draft.series);
  const grouped: NonNullable<TableCardSpec['aggregate']> = {
    ...aggregate,
    ...(groupBy ? { groupBy: { ...groupBy, ...(draft.dateBucket ? { dateBucket: draft.dateBucket } : {}) } } : {}),
    ...(groupBy && series ? { series } : {}),
    ...(draft.sort ? { sort: draft.sort } : {}),
    ...(draft.limit ? { limit: Number(draft.limit) } : {}),
  };
  if (draft.kind === 'pivot') return { kind: 'pivot', source, aggregate: grouped };
  return {
    kind: 'chart',
    source,
    aggregate: grouped,
    chart: {
      type: draft.chartType,
      ...(draft.stacked ? { stacked: true } : {}),
      ...(draft.horizontal ? { horizontal: true } : {}),
      ...(draft.donut ? { donut: true } : {}),
      ...(draft.showValues ? { showValues: true } : {}),
    },
  };
}
