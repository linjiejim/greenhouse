/**
 * Tables views on the phone — pure (root vitest: ./views.test.ts). The web's
 * `pages/tables/views/view-query.ts` rules for what each view type asks the
 * server, the kanban lanes, the calendar window and agenda, plus the phone's
 * session overrides (sort / filter / group / fields from the view-options sheet).
 *
 * Query shape per type:
 *  - list (grid): the view's query + overrides; grouped by a select / person
 *    field when one is chosen (headers are client-side from the loaded page);
 *  - kanban: one page of at most `VIEW_RECORD_LIMIT` records, lanes = the
 *    group field's options (or the people seen) + "no value";
 *  - calendar: records overlapping the visible month (web `calendarWindowFilters`);
 *  - gallery: the view's query, paged.
 */

import {
  TABLE_VIEW_NO_VALUE_GROUP,
  type TableFilterClause,
  type TableFilterGroup,
  type TableFilterOperator,
  type TableQuery,
  type TableSort,
  type TableSystemField,
  type TableViewConfig,
  type TableViewType,
} from '../../shared/tables';
import { effectiveType, fieldConfig, recordValue, type FieldLike } from './fields';

/** Kanban and calendar load one page of at most this many records (the server's page cap). */
export const VIEW_RECORD_LIMIT = 500;
/** List / gallery page size. */
export const VIEW_PAGE_SIZE = 50;

export const NO_VALUE_GROUP = TABLE_VIEW_NO_VALUE_GROUP;

/** A view's config, parsed (`TableView.config` is JSON text). */
export function viewConfig(view: { config: unknown } | null | undefined): TableViewConfig {
  const raw = view?.config;
  if (raw && typeof raw === 'object') return raw as TableViewConfig;
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as TableViewConfig) : {};
  } catch {
    return {};
  }
}

/** View types this build draws; anything else shows "open on the web" (an older build, a newer server). */
export const MOBILE_VIEW_TYPES: readonly TableViewType[] = ['grid', 'kanban', 'calendar', 'gallery'];

export function isMobileViewType(type: string): type is TableViewType {
  return (MOBILE_VIEW_TYPES as readonly string[]).includes(type);
}

// ─── Session overrides (the view-options sheet) ───────────

/**
 * What the phone changes on a view for this session — never saved to the view
 * (saving shared views is a builder's web job).
 */
export interface ViewOverrides {
  /** Replaces the view's sort when set. */
  sort?: TableSort[];
  /** ANDed onto the view's own query (`TableQuery.filters`). */
  clauses?: TableFilterClause[];
  /** Visible fields, in order (replaces the view's `fieldIds`). */
  fieldIds?: number[];
  /** List: group the loaded rows by this field (null = no grouping, overriding the view's). */
  groupFieldId?: number | null;
}

export function hasOverrides(overrides: ViewOverrides | undefined): boolean {
  return (
    !!overrides &&
    (!!overrides.sort || !!overrides.clauses?.length || !!overrides.fieldIds || overrides.groupFieldId !== undefined)
  );
}

/** Field ids a view shows, in order: the override, the view's, else every field. */
export function visibleFieldIds(
  config: TableViewConfig,
  fields: readonly FieldLike[],
  overrides?: ViewOverrides,
): number[] {
  const known = new Set(fields.map((field) => field.id));
  const chosen = overrides?.fieldIds ?? config.fieldIds;
  if (chosen?.length) return chosen.filter((id) => known.has(id));
  return fields.map((field) => field.id);
}

/** The list's grouping field: the override (null = none), else the view's own `groupBy` field. */
export function listGroupFieldId(config: TableViewConfig, overrides?: ViewOverrides): number | null {
  if (overrides && overrides.groupFieldId !== undefined) return overrides.groupFieldId;
  return config.groupBy?.fieldId ?? null;
}

/** Fields a list may group by on the phone (lanes read well): selects and people. */
export function groupableField(field: FieldLike): boolean {
  return field.type === 'single_select' || field.type === 'user';
}

/** Fields a list may sort by. */
export function sortableField(field: FieldLike): boolean {
  return !['multi_select', 'multi_user', 'attachment', 'relation', 'lookup', 'long_text'].includes(field.type);
}

/** The record query a view type asks for (cursor / limit added by the pager). */
export function viewQuery(
  type: TableViewType,
  config: TableViewConfig,
  opts: { overrides?: ViewOverrides; search?: string; extraFilters?: TableFilterGroup[] } = {},
): Omit<TableQuery, 'cursor' | 'limit'> {
  const base = config.query ?? {};
  const filters: TableFilterGroup[] = [...(base.filters ?? [])];
  const clauses = opts.overrides?.clauses ?? [];
  if (clauses.length) filters.push({ combinator: 'and', clauses });
  filters.push(...(opts.extraFilters ?? []));
  const sort = opts.overrides?.sort ?? base.sort;
  const search = opts.search?.trim() || base.search;
  return {
    ...(base.where ? { where: base.where } : {}),
    ...(filters.length ? { filters: filters.slice(0, 5) } : {}),
    ...(sort?.length ? { sort } : {}),
    ...(search ? { search } : {}),
    // a grid's own grouping orders the rows by group first (the list draws headers from that order)
    ...(type === 'grid' && config.groupBy && opts.overrides?.groupFieldId === undefined
      ? { groupBy: config.groupBy }
      : {}),
  };
}

// ─── Quick filters (the view-options sheet) ───────────────

/** Operators the phone offers per field type (a subset of the web's `FilterEditor`). */
export function filterOperators(field: FieldLike): TableFilterOperator[] {
  const type = effectiveType(field);
  switch (type) {
    case 'text':
    case 'long_text':
    case 'url':
    case 'email':
    case 'phone':
      return ['contains', 'not_contains', 'eq', 'is_empty', 'is_not_empty'];
    case 'number':
    case 'rollup':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'];
    case 'date':
    case 'datetime':
      return ['eq', 'gte', 'lte', 'is_empty', 'is_not_empty'];
    case 'boolean':
      return ['eq'];
    case 'single_select':
    case 'user':
      return ['eq', 'neq', 'is_empty', 'is_not_empty'];
    case 'multi_select':
    case 'multi_user':
      return ['contains', 'not_contains', 'is_empty', 'is_not_empty'];
    default:
      return ['is_empty', 'is_not_empty'];
  }
}

/** Operators that take no value. */
export function operatorTakesValue(operator: TableFilterOperator): boolean {
  return operator !== 'is_empty' && operator !== 'is_not_empty';
}

/** A filter clause ready to send, or null while it still needs a value. */
export function completeClause(clause: TableFilterClause): TableFilterClause | null {
  if (!operatorTakesValue(clause.operator)) return { ...clause, value: undefined };
  const value = clause.value;
  if (value === undefined || value === null || value === '') return null;
  return clause;
}

// ─── Grouping (list headers, kanban lanes) ────────────────

export interface RecordLike {
  id: number;
  values: Record<string, unknown>;
  computed_values?: Record<string, unknown>;
}

export interface Lane<R> {
  /** The option / user id; `NO_VALUE_GROUP` for records without one. */
  key: string;
  label: string;
  /** A select option's data colour, when it has one. */
  color?: string;
  records: R[];
}

/**
 * Lanes for a single-select / person field: one per option in option order (or
 * per person seen, by first appearance), then "no value" — hidden groups
 * dropped. Records holding an option that no longer exists land in "no value".
 */
export function groupRecords<R extends RecordLike>(
  field: FieldLike,
  records: readonly R[],
  opts: { userLabel: (id: string) => string; noValue: string; hidden?: readonly string[]; keepEmpty?: boolean },
): Lane<R>[] {
  const hidden = new Set(opts.hidden ?? []);
  const lanes = new Map<string, Lane<R>>();
  if (field.type === 'single_select') {
    for (const option of fieldConfig(field).options ?? []) {
      lanes.set(option.id, { key: option.id, label: option.label, color: option.color, records: [] });
    }
  }
  const empty: Lane<R> = { key: NO_VALUE_GROUP, label: opts.noValue, records: [] };
  for (const record of records) {
    const value = recordValue(record, field.id);
    const key = typeof value === 'string' && value ? value : NO_VALUE_GROUP;
    let lane = lanes.get(key);
    if (!lane && key !== NO_VALUE_GROUP && field.type === 'user') {
      lane = { key, label: opts.userLabel(key), records: [] };
      lanes.set(key, lane);
    }
    (lane ?? empty).records.push(record);
  }
  const out = [...lanes.values(), empty].filter((lane) => !hidden.has(lane.key));
  return opts.keepEmpty === false ? out.filter((lane) => lane.records.length > 0) : out;
}

/** The value a record takes when moved into a lane. */
export function laneValue(laneKey: string): string | null {
  return laneKey === NO_VALUE_GROUP ? null : laneKey;
}

// ─── Calendar (local calendar days) ───────────────────────

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD` of a local date. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of `YYYY-MM-DD`. */
export function dayStart(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year!, month! - 1, date!);
}

export function addDays(day: string, days: number): string {
  const date = dayStart(day);
  date.setDate(date.getDate() + days);
  return localDay(date);
}

/** The local day a stored date / datetime value falls on; null when it is not a date. */
export function dayOfValue(value: unknown, type: string): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10)) ? value.slice(0, 10) : null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : localDay(date);
}

/** First and last day of the month containing `day`. */
export function monthBounds(day: string): { first: string; last: string } {
  const start = dayStart(`${day.slice(0, 7)}-01`);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return { first: localDay(start), last: localDay(end) };
}

/**
 * Records overlapping `[first, last]` (inclusive local days): the start falls in
 * the window, or it starts earlier and ends inside or after it. Date fields
 * compare as `YYYY-MM-DD`; datetimes as the local window's instants.
 */
export function calendarWindowFilters(
  start: FieldLike,
  end: FieldLike | undefined,
  first: string,
  last: string,
): TableFilterGroup[] {
  const bound = (field: FieldLike, day: string, edge: 'from' | 'until') => {
    if (field.type === 'date') return { operator: edge === 'from' ? ('gte' as const) : ('lte' as const), value: day };
    const instant = dayStart(edge === 'from' ? day : addDays(day, 1)).toISOString();
    return { operator: edge === 'from' ? ('gte' as const) : ('lt' as const), value: instant };
  };
  const startsBeforeEnd: TableFilterGroup = {
    combinator: 'and',
    clauses: [{ fieldId: start.id, ...bound(start, last, 'until') }],
  };
  const reachesWindow: TableFilterGroup = end
    ? {
        combinator: 'or',
        clauses: [
          { fieldId: start.id, ...bound(start, first, 'from') },
          { fieldId: end.id, ...bound(end, first, 'from') },
        ],
      }
    : { combinator: 'and', clauses: [{ fieldId: start.id, ...bound(start, first, 'from') }] };
  return [startsBeforeEnd, reachesWindow];
}

/** Whether a record spans `day` (its start day, through its end day when it has one). */
export function onDay(record: RecordLike, start: FieldLike, end: FieldLike | undefined, day: string): boolean {
  const from = dayOfValue(recordValue(record, start.id), start.type);
  if (!from) return false;
  const to = end ? (dayOfValue(recordValue(record, end.id), end.type) ?? from) : from;
  return from <= day && day <= (to < from ? from : to);
}

/** The days of the month that have at least one record (for the agenda's day markers). */
export function busyDays(
  records: readonly RecordLike[],
  start: FieldLike,
  end: FieldLike | undefined,
  first: string,
  last: string,
): Set<string> {
  const out = new Set<string>();
  for (const record of records) {
    const from = dayOfValue(recordValue(record, start.id), start.type);
    if (!from) continue;
    const to = end ? (dayOfValue(recordValue(record, end.id), end.type) ?? from) : from;
    let day = from < first ? first : from;
    const stop = to > last ? last : to;
    for (let guard = 0; day <= stop && guard < 62; guard++) {
      out.add(day);
      day = addDays(day, 1);
    }
  }
  return out;
}

/** A system field as a sort / filter target (the record list's "created by", "updated"). */
export const SYSTEM_SORTS: readonly TableSystemField[] = ['created_at', 'updated_at'];
