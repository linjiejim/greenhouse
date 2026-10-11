/**
 * Pure helpers behind the view bodies: what each view type adds to the record
 * query (grid grouping, a calendar window, the kanban / calendar cap), group
 * keys that match the server's aggregate groups, kanban lanes, and the
 * calendar's month grid. No React, no requests — unit-tested in
 * `view-query.test.ts`.
 */

import {
  TABLE_VIEW_NO_VALUE_GROUP,
  type TableAggregateInput,
  type TableAggregateRow,
  type TableFilterGroup,
  type TableGroupBy,
  type TableSystemField,
  type TableViewConfig,
  type TableViewType,
} from '@greenhouse/types/tables';
import type { TableField, TableRecord, TableUserOption } from '../../../lib/api/tables';
import { fieldConfig } from '../../../components/tables/field-types';
import { recordFieldValue } from '../../../components/tables/field-value';
import type { RecordQueryShape } from '../use-record-query';
import type { TableViewQuery } from './types';

/** Kanban and calendar load one page of at most this many records (the server's page cap). */
export const VIEW_RECORD_LIMIT = 500;
/** The server returns at most this many groups per aggregate. */
export const GROUP_COUNT_LIMIT = 100;

export const NO_VALUE_GROUP = TABLE_VIEW_NO_VALUE_GROUP;

export function fieldById(fields: readonly TableField[], fieldId: number | undefined): TableField | undefined {
  return fieldId === undefined ? undefined : fields.find((field) => field.id === fieldId);
}

/** The viewer's IANA zone — date buckets and calendar days are local. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ─── Days ─────────────────────────────────────────────────

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

/** Whole days from `from` to `to` (local calendar days, DST-safe). */
export function daysBetween(from: string, to: string): number {
  const [a, b] = [dayStart(from), dayStart(to)];
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
      86_400_000,
  );
}

/** The local day a stored date / datetime value falls on; null when it is not a date. */
export function dayOfValue(value: unknown, type: TableField['type']): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : localDay(date);
}

/** `YYYY-MM` of the month containing `date`. */
export function monthOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split('-').map(Number);
  return monthOf(new Date(year!, index! - 1 + delta, 1));
}

/** Weeks start on Monday in Chinese, on Sunday in English. */
export function weekStartFor(locale: string): 0 | 1 {
  return locale.startsWith('zh') ? 1 : 0;
}

/** The 42 days (6 weeks) a month grid shows, starting on `weekStart`. */
export function monthGridDays(month: string, weekStart: 0 | 1): string[] {
  const first = dayStart(`${month}-01`);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const start = localDay(new Date(first.getFullYear(), first.getMonth(), 1 - lead));
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

// ─── Query shape per view type ────────────────────────────

/**
 * Records overlapping `[first, last]` (inclusive local days): the start falls in
 * the window, or it starts earlier and ends inside or after it. Date fields
 * compare as `YYYY-MM-DD`; datetimes as the local window's instants.
 */
export function calendarWindowFilters(
  start: TableField,
  end: TableField | undefined,
  first: string,
  last: string,
): TableFilterGroup[] {
  const bound = (field: TableField, day: string, edge: 'from' | 'until') => {
    if (field.type === 'date') return { operator: edge === 'from' ? ('gte' as const) : ('lte' as const), value: day };
    const instant = dayStart(edge === 'from' ? day : addDays(day, 1)).toISOString();
    return { operator: edge === 'from' ? ('gte' as const) : ('lt' as const), value: instant };
  };
  const startsBeforeEnd = {
    combinator: 'and' as const,
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

/** Clauses one filter group may hold (the compiler's `MAX_QUERY_CLAUSES`). */
const MAX_GROUP_CLAUSES = 20;

/** A group that means the same ANDed into another `and` group: an `and` group, or a single clause. */
function andable(group: TableFilterGroup): boolean {
  return group.combinator === 'and' || group.clauses.length <= 1;
}

/**
 * A saved view's filter as the container holds it. Views keep their filter in
 * `query.where` (what the filter dialog edits) and may carry extra
 * `query.filters` groups (an Agent plan writes them) that the record query
 * ANDs on. Every extra group a flat `where` can say is folded into it, so the
 * filter dialog shows and edits it; the rest (an `or` group next to another
 * condition) stay extra groups and still apply.
 */
export function foldSavedFilters(
  where: TableFilterGroup | undefined,
  filters: readonly TableFilterGroup[] | undefined,
): { where: TableFilterGroup | undefined; filters: TableFilterGroup[] | undefined } {
  let folded = where && where.clauses.length > 0 ? where : undefined;
  const rest: TableFilterGroup[] = [];
  for (const group of filters ?? []) {
    if (group.clauses.length === 0) continue;
    if (!folded) {
      folded = group;
      continue;
    }
    if (andable(folded) && andable(group) && folded.clauses.length + group.clauses.length <= MAX_GROUP_CLAUSES) {
      folded = { combinator: 'and', clauses: [...folded.clauses, ...group.clauses] };
    } else {
      rest.push(group);
    }
  }
  return { where: folded, filters: rest.length > 0 ? rest : undefined };
}

/** The extra filter groups of a record query: the saved view's, then what the view type adds. */
export function combinedFilters(
  saved: readonly TableFilterGroup[] | undefined,
  shape: readonly TableFilterGroup[] | undefined,
): TableFilterGroup[] | undefined {
  const all = [...(saved ?? []), ...(shape ?? [])];
  return all.length > 0 ? all : undefined;
}

/** The grid's grouping, when it still points at a field of the table. */
export function activeGroupBy(config: TableViewConfig, fields: readonly TableField[]): TableGroupBy | undefined {
  const groupBy = config.groupBy;
  if (!groupBy) return undefined;
  if (groupBy.systemField) return groupBy;
  return fieldById(fields, groupBy.fieldId) ? groupBy : undefined;
}

/** What `type` adds to the record query. */
export function viewQueryShape(
  type: TableViewType,
  config: TableViewConfig,
  fields: readonly TableField[],
  calendar: { month: string; weekStart: 0 | 1 },
): RecordQueryShape {
  if (type === 'kanban') return { limit: VIEW_RECORD_LIMIT };
  if (type === 'calendar') {
    const start = fieldById(fields, config.calendar?.startFieldId);
    if (!start) return { limit: VIEW_RECORD_LIMIT };
    const days = monthGridDays(calendar.month, calendar.weekStart);
    const end = fieldById(fields, config.calendar?.endFieldId);
    return { limit: VIEW_RECORD_LIMIT, filters: calendarWindowFilters(start, end, days[0]!, days[days.length - 1]!) };
  }
  if (type === 'grid') {
    const groupBy = activeGroupBy(config, fields);
    return groupBy ? { groupBy } : {};
  }
  return {};
}

// ─── Group keys ───────────────────────────────────────────

/** A grouping key that buckets by local day (datetimes and the time system columns). */
function groupsByDay(groupBy: TableGroupBy, field: TableField | undefined): boolean {
  if (groupBy.systemField) return groupBy.systemField === 'created_at' || groupBy.systemField === 'updated_at';
  return field?.type === 'datetime';
}

/** The aggregate that counts records per group, over the records on screen. */
export function groupCountInput(
  groupBy: TableGroupBy,
  field: TableField | undefined,
  query: TableViewQuery,
  timeZone: string,
): TableAggregateInput {
  const ref = groupBy.systemField ? { systemField: groupBy.systemField } : { fieldId: groupBy.fieldId };
  return {
    operation: 'count',
    groupBy: { ...ref, ...(groupsByDay(groupBy, field) ? { dateBucket: 'day' as const } : {}) },
    query: {
      ...(query.where ? { where: query.where } : {}),
      ...(query.filters?.length ? { filters: query.filters } : {}),
      ...(query.search ? { search: query.search } : {}),
    },
    sort: 'group_asc',
    limit: GROUP_COUNT_LIMIT,
    timezone: timeZone,
  };
}

/** Aggregate rows → count per group key (the empty string and null are both "no value"). */
export function countsByGroup(rows: readonly TableAggregateRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.group === null ? NO_VALUE_GROUP : String(row.group);
    counts.set(key, (counts.get(key) ?? 0) + row.value);
  }
  return counts;
}

function systemValue(record: TableRecord, field: TableSystemField): string {
  return record[field];
}

/** The group a record falls in — the same text the server's aggregate groups by. */
export function recordGroupKey(record: TableRecord, groupBy: TableGroupBy, field: TableField | undefined): string {
  const value = groupBy.systemField
    ? systemValue(record, groupBy.systemField)
    : recordFieldValue(record, groupBy.fieldId!);
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return NO_VALUE_GROUP;
  }
  if (groupsByDay(groupBy, field)) return dayOfValue(value, 'datetime') ?? NO_VALUE_GROUP;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

// ─── Kanban lanes ─────────────────────────────────────────

export interface KanbanLane {
  key: string;
  /** Empty for the "no value" lane (the body labels it). */
  label: string;
  /** What a card dropped here is written as. */
  value: string | null;
}

/**
 * Lanes in order: a select's options in option order; a person field's people
 * who appear in the records or the counts, by name. "No value" comes last.
 */
export function kanbanLanes(
  field: TableField,
  records: readonly TableRecord[],
  counts: ReadonlyMap<string, number> | null,
  usersById: ReadonlyMap<string, Pick<TableUserOption, 'nickname'>>,
): KanbanLane[] {
  const none: KanbanLane = { key: NO_VALUE_GROUP, label: '', value: null };
  if (field.type === 'single_select') {
    const options = fieldConfig(field).options ?? [];
    return [...options.map((option) => ({ key: option.id, label: option.label, value: option.id })), none];
  }
  const people = new Set<string>();
  for (const key of counts?.keys() ?? []) if (key !== NO_VALUE_GROUP) people.add(key);
  for (const record of records) {
    const value = recordFieldValue(record, field.id);
    if (typeof value === 'string' && value) people.add(value);
  }
  const lanes = [...people].map((id) => ({ key: id, label: usersById.get(id)?.nickname ?? id, value: id }));
  lanes.sort((left, right) => left.label.localeCompare(right.label));
  return [...lanes, none];
}

/** The lane a record sits in: its value when that is a lane, "no value" otherwise. */
export function recordLaneKey(record: TableRecord, field: TableField, lanes: readonly KanbanLane[]): string {
  const value = recordFieldValue(record, field.id);
  return typeof value === 'string' && lanes.some((lane) => lane.key === value) ? value : NO_VALUE_GROUP;
}
