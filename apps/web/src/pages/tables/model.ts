/**
 * What every view of a table works out the same way: which fields show and in what order, the
 * groups records fall into, values as text, days and the timeline's geometry. No React here.
 */

import {
  formatCell,
  isEmptyValue,
  isSystemField,
  linkTarget,
  zonedDay,
  zonedInstant,
  zonedParts,
  type CellContext,
  type Field,
  type LinkedRecord,
  type MemberSummary,
  type RecordFile,
  type SystemField,
  type TableRecord,
  type ViewConfig,
} from '@greenhouse/contract';

/** The primary field first, then the view's order, then the table's; `hidden` ones left out unless asked. */
export function orderedFields(fields: readonly Field[], config: ViewConfig, withHidden = false): Field[] {
  const order = new Map((config.order ?? []).map((id, index) => [id, index]));
  const hidden = new Set(config.hidden ?? []);
  return [...fields]
    .filter((field) => withHidden || field.is_primary || !hidden.has(field.id))
    .sort((a, b) => {
      if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
      const ai = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bi = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi || a.position - b.position;
    });
}

/** Moves a field one place in the view's order (the order then names every field). */
export function moveField(fields: readonly Field[], config: ViewConfig, id: string, by: -1 | 1): string[] {
  const ids = orderedFields(fields, config, true)
    .filter((field) => !field.is_primary)
    .map((field) => field.id);
  const at = ids.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= ids.length) return ids;
  [ids[at], ids[to]] = [ids[to]!, ids[at]!];
  return ids;
}

export const primaryOf = (fields: readonly Field[]) => fields.find((field) => field.is_primary);

export const titleOf = (fields: readonly Field[], record: Pick<TableRecord, 'values'>) => {
  const primary = primaryOf(fields);
  const value = primary ? record.values[primary.id] : null;
  return typeof value === 'string' ? value : '';
};

export interface CellLookups {
  members: ReadonlyMap<string, MemberSummary>;
  linked: Record<string, LinkedRecord>;
  files: Record<string, RecordFile>;
  timeZone: string;
}

export const cellContext = (lookups: CellLookups): CellContext => ({
  timeZone: lookups.timeZone,
  memberName: (id) => lookups.members.get(id)?.name,
  linkedTitle: (id) => lookups.linked[id]?.title,
  fileName: (id) => lookups.files[id]?.name,
});

/** A field's or a system field's value as text (copy, search hints, group labels). */
export function valueText(field: Field | SystemField, record: TableRecord, lookups: CellLookups): string {
  if (typeof field === 'string') {
    const value =
      field === 'created_by' ? record.created_by : field === 'updated_by' ? record.updated_by : record[field];
    if (field === 'created_by' || field === 'updated_by') return lookups.members.get(value ?? '')?.name ?? '';
    return value ? (zonedDay(value, lookups.timeZone) ?? '') : '';
  }
  return formatCell(field, record.values[field.id], cellContext(lookups));
}

/** The value records are grouped by: an option id, a member id, true / false, a day, text; '' for none. */
export function groupKey(field: Field | SystemField, record: TableRecord): string {
  if (typeof field === 'string') return (field === 'created_by' ? record.created_by : record.updated_by) ?? '';
  const value = record.values[field.id];
  if (field.type === 'checkbox') return value === true ? 'true' : 'false';
  if (isEmptyValue(value)) return '';
  if (Array.isArray(value)) return String(value[0] ?? '');
  return String(value);
}

export interface RecordGroup {
  key: string;
  records: TableRecord[];
}

/** Preserve the server's group order, including while a new query still shows cached records. */
export function groupRecords(records: readonly TableRecord[], field: Field | SystemField): RecordGroup[] {
  const groups = new Map<string, RecordGroup>();
  for (const record of records) {
    const key = groupKey(field, record);
    const group = groups.get(key);
    if (group) group.records.push(record);
    else groups.set(key, { key, records: [record] });
  }
  return [...groups.values()];
}

/** A field id or a system field, as the view config stores it, back to what it names. */
export function resolveField(fields: readonly Field[], ref: string | undefined): Field | SystemField | undefined {
  if (!ref) return undefined;
  if (isSystemField(ref)) return ref;
  return fields.find((field) => field.id === ref);
}

export const linkTable = linkTarget;

// ── Days ────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
export const dayOf = (number: number) => new Date(number * DAY_MS).toISOString().slice(0, 10);
export const addDays = (day: string, days: number) => dayOf(dayNumber(day) + days);
export const todayIn = (timeZone: string) => zonedDay(new Date().toISOString(), timeZone);

/** The day a date or date-time value falls on, in the reader's zone; null when empty. */
export function dayOfValue(value: unknown, timeZone: string): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return zonedDay(value, timeZone) || null;
}

/** Monday on or before a day. */
export const weekStart = (day: string) => {
  const number = dayNumber(day);
  const weekday = (new Date(number * DAY_MS).getUTCDay() + 6) % 7;
  return dayOf(number - weekday);
};

/** The weeks (Monday first) a month's calendar shows: 6 rows of 7 days. */
export function monthGrid(month: string): string[][] {
  const first = weekStart(`${month}-01`);
  return Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (__, day) => addDays(first, week * 7 + day)));
}

// ── Timeline ────────────────────────────────────────────

export const SCALE_DAY_PX = { day: 40, week: 18, month: 5 } as const;

export interface Span {
  start: string;
  end: string;
}

/** A record's span on the timeline: its start and end days (an end before the start, or none, is the start). */
export function spanOf(
  record: TableRecord,
  startField: Field,
  endField: Field | undefined,
  timeZone: string,
): Span | null {
  const start = dayOfValue(record.values[startField.id], timeZone);
  const end = endField ? dayOfValue(record.values[endField.id], timeZone) : null;
  if (!start && !end) return null;
  const from = start ?? end!;
  const to = end && end >= from ? end : from;
  return { start: from, end: to };
}

/**
 * A date or date-time value moved by whole days; a date-time keeps its time of day on the
 * reader's clock, also across a daylight-saving change.
 */
export function shiftValue(value: unknown, field: Field, days: number, timeZone: string): unknown {
  if (typeof value !== 'string' || !value) return value;
  if (field.type === 'date') return addDays(value, days);
  const instant = Date.parse(value);
  const parts = Number.isNaN(instant) ? null : zonedParts(value, timeZone);
  if (!parts) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = addDays(`${parts.year}-${pad(parts.month)}-${pad(parts.day)}`, days);
  const moved = Date.parse(zonedInstant(day, `${pad(parts.hour)}:${pad(parts.minute)}`, timeZone));
  // Seconds and milliseconds are not on the clock face; they stay as they were.
  return new Date(moved + (((instant % 60_000) + 60_000) % 60_000)).toISOString();
}

/** The value a field takes for a day: the day itself; for a date-time the same time of day, or 09:00. */
export function valueForDay(field: Field, day: string, previous: unknown, timeZone: string): unknown {
  if (field.type === 'date') return day;
  const before = dayOfValue(previous, timeZone);
  if (typeof previous === 'string' && before) {
    return shiftValue(previous, field, dayNumber(day) - dayNumber(before), timeZone);
  }
  return zonedInstant(day, '09:00', timeZone);
}

export interface TimelineRow {
  record: TableRecord;
  depth: number;
  hasChildren: boolean;
}

/**
 * Records in timeline order: by start day, children right after their parent (indented), the
 * children of collapsed parents left out.
 */
export function timelineRows(
  records: readonly TableRecord[],
  spans: ReadonlyMap<string, Span | null>,
  parentField: Field | undefined,
  collapsed: ReadonlySet<string>,
): TimelineRow[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const children = new Map<string, TableRecord[]>();
  const roots: TableRecord[] = [];
  for (const record of records) {
    const parent = parentField ? (record.values[parentField.id] as string[] | undefined)?.[0] : undefined;
    if (parent && byId.has(parent) && parent !== record.id) {
      const kids = children.get(parent);
      if (kids) kids.push(record);
      else children.set(parent, [record]);
    } else roots.push(record);
  }
  const order = (a: TableRecord, b: TableRecord) => {
    const sa = spans.get(a.id)?.start ?? '9999';
    const sb = spans.get(b.id)?.start ?? '9999';
    return sa < sb ? -1 : sa > sb ? 1 : a.id < b.id ? -1 : 1;
  };
  const rows: TimelineRow[] = [];
  const seen = new Set<string>();
  /** Children of a collapsed record are walked too (they are placed), only not shown. */
  const walk = (record: TableRecord, depth: number, hidden: boolean) => {
    if (seen.has(record.id)) return;
    seen.add(record.id);
    const kids = (children.get(record.id) ?? []).sort(order);
    if (!hidden) rows.push({ record, depth, hasChildren: kids.length > 0 });
    for (const kid of kids) walk(kid, depth + 1, hidden || collapsed.has(record.id));
  };
  for (const root of roots.sort(order)) walk(root, 0, false);
  // Parents that point at each other (the server refuses it; old data may not) still show.
  for (const record of [...records].sort(order)) if (!seen.has(record.id)) walk(record, 0, false);
  return rows;
}

/** Whether a record is a milestone on this timeline. */
export function isMilestone(record: TableRecord, timeline: ViewConfig['timeline'], fields: readonly Field[]): boolean {
  if (!timeline?.milestone) return false;
  const field = fields.find((entry) => entry.id === timeline.milestone!.field);
  if (!field) return false;
  const value = record.values[field.id];
  return field.type === 'checkbox' ? value === true : value === timeline.milestone.option;
}
