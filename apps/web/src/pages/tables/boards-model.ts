/**
 * What the board views (kanban, calendar, gallery) work out from a table's fields and the view's
 * records: the fields a card shows, kanban columns and what a move writes, where records fall on
 * a month and what a drag to another day writes, and gallery covers. No React here.
 */

import {
  isEmptyValue,
  isComputedType,
  zonedParts,
  type Field,
  type FieldType,
  type RecordFile,
  type RecordValues,
  type SelectOption,
  type TableRecord,
  type ViewConfig,
} from '@greenhouse/contract';
import { dayNumber, orderedFields, shiftValue, spanOf, valueForDay, type Span } from './model';

// ── Cards ───────────────────────────────────────────────

/** Fields a card shows under its title. */
export const CARD_FIELDS = 4;
/** Field types that read as chips (an agenda row has room for nothing else). */
export const CHIP_TYPES = ['single_select', 'multi_select', 'member'] as const satisfies readonly FieldType[];

/** Whether a value shows anything: a checkbox only when ticked. */
export const hasValue = (field: Field, value: unknown) =>
  field.type === 'checkbox' ? value === true : !isEmptyValue(value);

/**
 * The fields a card shows under its title: the view's visible fields after the primary one, in
 * the view's order, without those the view already shows another way (`skip`), at most `limit`.
 */
export function cardFields(
  fields: readonly Field[],
  config: ViewConfig,
  skip: readonly (string | undefined)[] = [],
  { limit = CARD_FIELDS, types }: { limit?: number; types?: readonly FieldType[] } = {},
): Field[] {
  return orderedFields(fields, config)
    .filter((field) => !field.is_primary && !skip.includes(field.id) && (!types || types.includes(field.type)))
    .slice(0, limit);
}

/** How many a 「再显示」 adds: the next page, or what is left. */
export const moreCount = (total: number, shown: number, page: number) => Math.max(0, Math.min(page, total - shown));

// ── Kanban ──────────────────────────────────────────────

/** Cards a column renders before 「再显示 N 条」. */
export const KANBAN_PAGE = 100;

/** A kanban splits by a single select, or by a member field that holds one member. */
export const canSplitBy = (field: Field) =>
  field.type === 'single_select' || (field.type === 'member' && !field.config.multiple);

/** The field the view's kanban splits by; undefined when it is not set or cannot split. */
export function kanbanField(fields: readonly Field[], config: ViewConfig): Field | undefined {
  const field = fields.find((entry) => entry.id === config.kanban?.field);
  return field && canSplitBy(field) ? field : undefined;
}

/** The field a new kanban would split by: the first single select, else the first single member field. */
export const firstKanbanField = (fields: readonly Field[]) =>
  fields.find((field) => field.type === 'single_select') ??
  fields.find((field) => field.type === 'member' && !field.config.multiple);

export interface KanbanColumn {
  /** The option or member id; '' for 「（无）」. */
  key: string;
  /** A single select's option. */
  option?: SelectOption;
  records: TableRecord[];
}

const firstId = (value: unknown) => {
  const id = Array.isArray(value) ? value.find((entry) => typeof entry === 'string' && entry) : undefined;
  return typeof id === 'string' ? id : '';
};

/** The column a record is in: its option (one that still exists), its first member, else ''. */
export function columnKeyOf(field: Field, record: Pick<TableRecord, 'values'>): string {
  const value = record.values[field.id];
  if (field.type !== 'single_select') return firstId(value);
  return typeof value === 'string' && field.config.options?.some((option) => option.id === value) ? value : '';
}

const collator = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' });

/**
 * Every column of the kanban, 「（无）」 first: a single select's options in their order, or the
 * members who appear by name (unknown ones last). Records keep the view's order in each.
 */
export function kanbanColumns(
  field: Field,
  records: readonly TableRecord[],
  nameOf: (memberId: string) => string | undefined,
): KanbanColumn[] {
  const none: KanbanColumn = { key: '', records: [] };
  const columns = new Map<string, KanbanColumn>();
  if (field.type === 'single_select') {
    for (const option of field.config.options ?? []) columns.set(option.id, { key: option.id, option, records: [] });
  }
  for (const record of records) {
    const value = record.values[field.id];
    const key =
      field.type === 'single_select' ? (typeof value === 'string' && columns.has(value) ? value : '') : firstId(value);
    if (!key) {
      none.records.push(record);
      continue;
    }
    let column = columns.get(key);
    if (!column) columns.set(key, (column = { key, records: [] }));
    column.records.push(record);
  }
  const rest = [...columns.values()];
  if (field.type !== 'single_select') {
    const byKey = (a: KanbanColumn, b: KanbanColumn) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    rest.sort((a, b) => {
      const an = nameOf(a.key);
      const bn = nameOf(b.key);
      if (an === undefined || bn === undefined) return an === bn ? byKey(a, b) : an === undefined ? 1 : -1;
      return collator.compare(an, bn) || byKey(a, b);
    });
  }
  return [none, ...rest];
}

/** The columns on screen: without the empty ones when the view hides them. */
/**
 * The columns a board shows. 「（无）」 shows while it has records, or on a wide screen where
 * a card can be dragged into it; a phone would give it a whole screen of nothing (cards still
 * move there from their menu).
 */
export const visibleColumns = (columns: readonly KanbanColumn[], hideEmpty: boolean, narrow = false) =>
  columns.filter((column) => column.records.length > 0 || !(hideEmpty || (narrow && !column.key)));

/** The value a record takes in a column: the option id or null; [member] or []. */
export const columnValue = (field: Field, key: string): unknown =>
  field.type === 'single_select' ? key || null : key ? [key] : [];

/** What moving a record to a column writes; null when it is already there. */
export function moveToColumn(field: Field, record: Pick<TableRecord, 'values'>, key: string): RecordValues | null {
  return columnKeyOf(field, record) === key ? null : { [field.id]: columnValue(field, key) };
}

/** The values of a record added at the bottom of a column. */
export const newInColumn = (field: Field, key: string): RecordValues =>
  key ? { [field.id]: columnValue(field, key) } : {};

// ── Calendar ────────────────────────────────────────────

/** Records a day shows before 「还有 N 条」. */
export const DAY_CHIPS = 3;

export const isDateField = (field: Field) => field.type === 'date' || field.type === 'datetime';

/** The calendar's start and end fields; null when the start is not set or is not a date. */
export function calendarFields(fields: readonly Field[], config: ViewConfig): { start: Field; end?: Field } | null {
  const pick = (id: string | undefined) => fields.find((field) => field.id === id && isDateField(field));
  const start = pick(config.calendar?.start);
  if (!start) return null;
  const end = config.calendar?.end === start.id ? undefined : pick(config.calendar?.end);
  return end ? { start, end } : { start };
}

/** The field a new calendar would start from: the first date or date-time field. */
export const firstDateField = (fields: readonly Field[]) => fields.find(isDateField);

/** 'YYYY-MM' of a day. */
export const monthOf = (day: string) => day.slice(0, 7);

/** A month ('YYYY-MM') moved by whole months. */
export function shiftMonth(month: string, by: number): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + number - 1 + by;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export interface Placed {
  record: TableRecord;
  span: Span;
}

/**
 * The records on each of `days` (consecutive, in order): a record is on every day from its start
 * to its end that is among them. A day lists the records that began earlier first, then by start
 * time, then in the view's order.
 */
export function placeRecords(
  records: readonly TableRecord[],
  start: Field,
  end: Field | undefined,
  timeZone: string,
  days: readonly string[],
): Map<string, Placed[]> {
  const placed = new Map<string, Placed[]>();
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return placed;
  const entries = records.flatMap((record, index) => {
    const span = spanOf(record, start, end, timeZone);
    if (!span || span.end < first || span.start > last) return [];
    const value = record.values[start.id];
    const at = start.type === 'datetime' && typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return [{ record, span, index, at: Number.isNaN(at) ? Number.POSITIVE_INFINITY : at }];
  });
  entries.sort(
    (a, b) =>
      (a.span.start < b.span.start ? -1 : a.span.start > b.span.start ? 1 : 0) ||
      (a.at === b.at ? 0 : a.at < b.at ? -1 : 1) ||
      a.index - b.index,
  );
  const base = dayNumber(first);
  for (const { record, span } of entries) {
    const from = Math.max(0, dayNumber(span.start) - base);
    const to = Math.min(days.length - 1, dayNumber(span.end) - base);
    for (let index = from; index <= to; index++) {
      const day = days[index]!;
      const list = placed.get(day);
      if (list) list.push({ record, span });
      else placed.set(day, [{ record, span }]);
    }
  }
  return placed;
}

/** The days of a month ('YYYY-MM') that have records, in order. */
export const agendaDays = (placed: ReadonlyMap<string, Placed[]>, days: readonly string[], month: string) =>
  days.filter((day) => monthOf(day) === month && !!placed.get(day)?.length);

/** What dragging a record by whole days writes: its start, and its end by as many days; null for none. */
export function moveByDays(
  record: TableRecord,
  start: Field,
  end: Field | undefined,
  days: number,
  timeZone: string,
): RecordValues | null {
  if (!days || isComputedType(start.type) || (end && isComputedType(end.type))) return null;
  const values: RecordValues = {};
  for (const field of end ? [start, end] : [start]) {
    const value = record.values[field.id];
    if (!isEmptyValue(value)) values[field.id] = shiftValue(value, field, days, timeZone);
  }
  return Object.keys(values).length ? values : null;
}

/** The values of a record added on a day: its start on that day (09:00 for a date-time). */
export const newOnDay = (start: Field, day: string, timeZone: string): RecordValues => ({
  ...(!isComputedType(start.type) ? { [start.id]: valueForDay(start, day, undefined, timeZone) } : {}),
});

/** A date-time value's time of day in the reader's zone (HH:mm); '' for dates and empty values. */
export function timeOfDay(field: Field, value: unknown, timeZone: string): string {
  if (field.type !== 'datetime' || typeof value !== 'string' || !value) return '';
  const parts = zonedParts(value, timeZone);
  return parts ? `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}` : '';
}

// ── Gallery ─────────────────────────────────────────────

/** Cards the gallery renders before 「再显示 N 条」. */
export const GALLERY_PAGE = 200;

/** The gallery's cover field: an attachment field, else undefined. */
export function coverField(fields: readonly Field[], config: ViewConfig): Field | undefined {
  const field = fields.find((entry) => entry.id === config.gallery?.cover);
  return field?.type === 'attachment' ? field : undefined;
}

/** A record's cover: the first picture in the cover field. */
export function coverOf(
  record: Pick<TableRecord, 'values'>,
  field: Field | undefined,
  fileOf: (id: string) => RecordFile | undefined,
): RecordFile | undefined {
  const ids = field ? record.values[field.id] : undefined;
  if (!Array.isArray(ids)) return undefined;
  for (const id of ids) {
    const file = typeof id === 'string' ? fileOf(id) : undefined;
    if (file?.content_type.startsWith('image/')) return file;
  }
  return undefined;
}
