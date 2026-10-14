/**
 * The timeline's numbers, apart from React: the fields it draws with, the days it covers, the axis
 * cells, which rows and days to draw at a scroll position, where bars and dependency arrows go,
 * what a drag or an Alt + arrow key makes of a span and the values that saves. Days are whole days
 * since 1970-01-01 (model.ts dayNumber); x is pixels from the left edge of the time area.
 */

import type { Field, RecordValues, TableRecord, TimelineScale, ViewConfig } from '@greenhouse/contract';
import { layout, space } from '@greenhouse/ui/tokens';
import { dayNumber, dayOf, dayOfValue, spanOf, valueForDay, type Span, type TimelineRow } from './model';

// ── Sizes (the tokens tables-timeline.css uses) ─────────

export const HEADER_HEIGHT = space['10'];
export const ROW_HEIGHT = layout.rowCompact;
/** Phones: every row is a 44 tap target. */
export const ROW_HEIGHT_NARROW = layout.touchTarget;
export const TITLE_WIDTH = space['1'] * 56;
export const TITLE_WIDTH_NARROW = space['10'] * 3;
/** A bar's height, and the box a milestone's diamond sits in. */
export const BAR_HEIGHT = space['6'];
/** The narrowest a bar is drawn (a day is 5 px on the month scale). */
export const MIN_BAR_WIDTH = space['2'];

// ── Setup ───────────────────────────────────────────────

export type TimelineConfig = NonNullable<ViewConfig['timeline']>;

export interface TimelineSetup {
  timeline: TimelineConfig;
  start: Field;
  end?: Field;
  dependency?: Field;
  /** The table's parent field: children follow their parent. */
  parent?: Field;
}

export const isDateField = (field: Field) => field.type === 'date' || field.type === 'datetime';

/** The fields a timeline draws with; null when it has no start date field to draw by. */
export function timelineSetup(config: ViewConfig, fields: readonly Field[]): TimelineSetup | null {
  const timeline = config.timeline;
  if (!timeline) return null;
  const start = fields.find((field) => field.id === timeline.start && isDateField(field));
  if (!start) return null;
  return {
    timeline,
    start,
    end: fields.find((field) => field.id === timeline.end && field.id !== start.id && isDateField(field)),
    dependency: fields.find((field) => field.id === timeline.dependency && field.type === 'dependency'),
    parent: fields.find((field) => field.type === 'parent'),
  };
}

/** The settings that set a timeline up: by the table's first date field, a week at a glance. */
export function defaultTimeline(config: ViewConfig, fields: readonly Field[]): ViewConfig | null {
  const date = fields.find(isDateField);
  return date ? { ...config, timeline: { start: date.id, scale: 'week' } } : null;
}

// ── Days ────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** A span as day numbers, both ends included. */
export interface DaySpan {
  start: number;
  end: number;
}

export const toDaySpan = (span: Span): DaySpan => ({ start: dayNumber(span.start), end: dayNumber(span.end) });

export interface RecordSpan {
  span: Span;
  days: DaySpan;
}

const spansOf = new WeakMap<TableRecord, Map<string, RecordSpan | null>>();

/**
 * A record's span (model.ts spanOf) and its day numbers, kept per record object: a saved record
 * comes back as a new object and the others keep theirs, so a save works out one span again,
 * not a thousand (a date-time's day costs a time zone lookup).
 */
export function recordSpan(record: TableRecord, start: Field, end: Field | undefined, timeZone: string) {
  const key = [start.id, start.type, end?.id, end?.type, timeZone].join('|');
  let known = spansOf.get(record);
  if (!known) spansOf.set(record, (known = new Map()));
  let entry = known.get(key);
  if (entry === undefined) {
    const span = spanOf(record, start, end, timeZone);
    entry = span && { span, days: toDaySpan(span) };
    known.set(key, entry);
  }
  return entry;
}

export const sameSpan = (a: DaySpan | null | undefined, b: DaySpan | null | undefined) =>
  a?.start === b?.start && a?.end === b?.end;

/** Monday 0 … Sunday 6 (day 0, 1970-01-01, was a Thursday). */
export const weekdayOf = (day: number) => (((day + 3) % 7) + 7) % 7;

export function dateParts(day: number) {
  const date = new Date(day * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, date: date.getUTCDate() };
}

const utcDay = (year: number, monthIndex: number, date: number) => Date.UTC(year, monthIndex, date) / DAY_MS;

export type AxisUnit = 'day' | 'week' | 'month' | 'year';

/** The first day of the unit (a week starts on Monday) a day falls in. */
export function unitStart(unit: AxisUnit, day: number): number {
  switch (unit) {
    case 'day':
      return day;
    case 'week':
      return day - weekdayOf(day);
    case 'month': {
      const { year, month } = dateParts(day);
      return utcDay(year, month - 1, 1);
    }
    case 'year':
      return utcDay(dateParts(day).year, 0, 1);
  }
}

/** The first day of the unit after the one a day falls in. */
export function unitNext(unit: AxisUnit, day: number): number {
  switch (unit) {
    case 'day':
      return day + 1;
    case 'week':
      return unitStart('week', day) + 7;
    case 'month': {
      const { year, month } = dateParts(day);
      return utcDay(year, month, 1);
    }
    case 'year':
      return utcDay(dateParts(day).year + 1, 0, 1);
  }
}

// ── The days a timeline covers ──────────────────────────

/** First and last day drawn, both included. */
export interface DayRange {
  from: number;
  to: number;
}

/** Days kept free before the first and after the last record, about 600 px on each scale. */
const MARGIN_DAYS: Record<TimelineScale, number> = { day: 14, week: 35, month: 120 };
/** Ranges start and end on whole weeks (Monday first, so weekends repeat from the left edge) or months. */
const RANGE_UNIT: Record<TimelineScale, AxisUnit> = { day: 'week', week: 'week', month: 'month' };

/** The records' days and today with a margin, in whole weeks or months, at least `minDays` long. */
export function timelineRange(
  spans: Iterable<DaySpan | null | undefined>,
  today: number,
  scale: TimelineScale,
  minDays = 0,
): DayRange {
  let first = today;
  let last = today;
  for (const span of spans) {
    if (!span) continue;
    first = Math.min(first, span.start);
    last = Math.max(last, span.end);
  }
  const unit = RANGE_UNIT[scale];
  const from = unitStart(unit, first - MARGIN_DAYS[scale]);
  let to = unitNext(unit, last + MARGIN_DAYS[scale]) - 1;
  if (to - from + 1 < minDays) to = unitNext(unit, from + minDays - 1) - 1;
  return { from, to };
}

/** The day a timeline opens on: today while the records run through it, else where they begin. */
export function initialDay(spans: Iterable<DaySpan | null | undefined>, today: number): number {
  let first = Infinity;
  let last = -Infinity;
  for (const span of spans) {
    if (!span) continue;
    first = Math.min(first, span.start);
    last = Math.max(last, span.end);
  }
  if (first === Infinity) return today;
  return today >= first && today <= last ? today : first;
}

// ── The axis ────────────────────────────────────────────

/** The two tiers of the header for each scale. */
export const AXIS_UNITS: Record<TimelineScale, { upper: AxisUnit; lower: AxisUnit }> = {
  day: { upper: 'month', lower: 'day' },
  week: { upper: 'month', lower: 'week' },
  month: { upper: 'year', lower: 'month' },
};

/** One header cell: the days it spans in the range, and the date its unit starts on (for its label). */
export interface AxisCell {
  start: number;
  end: number;
  year: number;
  month: number;
  date: number;
}

/** The cells of one header tier that touch days `first` to `last`, cut to the range. */
export function axisCells(unit: AxisUnit, range: DayRange, first: number, last: number): AxisCell[] {
  const cells: AxisCell[] = [];
  const stop = Math.min(last, range.to);
  for (let start = unitStart(unit, Math.max(first, range.from)); start <= stop; start = unitNext(unit, start)) {
    cells.push({
      start: Math.max(start, range.from),
      end: Math.min(unitNext(unit, start) - 1, range.to),
      ...dateParts(start),
    });
  }
  return cells;
}

// ── What to draw at a scroll position ───────────────────

/** Rows are drawn in steps of this many, so scrolling a little draws nothing new. */
export const ROW_STEP = 8;
/** Rows drawn beyond the step on each side. */
export const ROW_OVERSCAN = 4;

export const rowStepAt = (scrollTop: number, rowHeight: number) =>
  Math.max(0, Math.floor(scrollTop / (rowHeight * ROW_STEP)));

/** The rows to draw at a scroll step: the ones in view, the rest of the step and a few more. */
export function rowWindow(step: number, viewportHeight: number, rowHeight: number, count: number) {
  if (count <= 0) return { first: 0, last: -1 };
  const top = Math.min(step * ROW_STEP, count - 1);
  return {
    first: Math.max(0, top - ROW_OVERSCAN),
    last: Math.min(count - 1, top + Math.ceil(Math.max(0, viewportHeight) / rowHeight) + ROW_STEP + ROW_OVERSCAN),
  };
}

/** Screens scrolled sideways: the header draws its cells again once per screen. */
export const pageAt = (scrollLeft: number, viewportWidth: number) =>
  Math.max(0, Math.floor(scrollLeft / Math.max(1, viewportWidth)));

/** The days (counted from the range's first) whose header cells to draw at a page: a screen before, two after. */
export function dayWindow(page: number, viewportWidth: number, px: number, total: number) {
  const width = Math.max(1, viewportWidth);
  return {
    first: Math.max(0, Math.floor(((page - 1) * width) / px)),
    last: Math.min(total - 1, Math.ceil(((page + 3) * width) / px)),
  };
}

/** The scrollLeft that puts the middle of a day `at` (0 to 1) of the way across the visible time area. */
export const scrollLeftFor = (day: number, from: number, px: number, viewportWidth: number, at = 0.5) =>
  Math.max(0, Math.round(dayCenter(day, from, px) - viewportWidth * at));

/** The day (with its fraction) in the middle of the visible time area. */
export const centerDayAt = (scrollLeft: number, from: number, px: number, viewportWidth: number) =>
  from + (scrollLeft + viewportWidth / 2) / px;

/** The scrollLeft that brings a day (with its fraction) back to the middle, on any scale. */
export const scrollLeftForCenter = (center: number, from: number, px: number, viewportWidth: number) =>
  Math.max(0, Math.round((center - from) * px - viewportWidth / 2));

// ── Bars, milestones and arrows ─────────────────────────

export const dayCenter = (day: number, from: number, px: number) => (day - from + 0.5) * px;

export function barBox(span: DaySpan, from: number, px: number) {
  return { left: (span.start - from) * px, width: Math.max(MIN_BAR_WIDTH, (span.end - span.start + 1) * px) };
}

/** Half a milestone's diamond: its arrows leave and arrive there. */
export const MILESTONE_REACH = space['2'];

/** Where arrows arrive at a bar or milestone (left) and leave it (right). */
export function anchorsOf(span: DaySpan, milestone: boolean, from: number, px: number) {
  if (milestone) {
    const center = dayCenter(span.end, from, px);
    return { left: center - MILESTONE_REACH, right: center + MILESTONE_REACH };
  }
  const box = barBox(span, from, px);
  return { left: box.left, right: box.left + box.width };
}

/** How far an arrow runs out of a bar before it turns. */
export const ARROW_STUB = space['2'];
export const ARROW_HEAD = 4;

/**
 * An arrow from the end of one bar (x1 on the middle y1 of its row) into the start of another
 * (x2, y2), in right angles: across and down when there is room, else out, along the edge of the
 * target's row, back and in.
 */
export function arrowPath(x1: number, y1: number, x2: number, y2: number, rowHeight: number): string {
  if (x2 - x1 >= ARROW_STUB * 2) return `M${x1} ${y1}H${x1 + ARROW_STUB}V${y2}H${x2}`;
  const edge = y2 > y1 ? y2 - rowHeight / 2 : y2 + rowHeight / 2;
  return `M${x1} ${y1}H${x1 + ARROW_STUB}V${edge}H${x2 - ARROW_STUB}V${y2}H${x2}`;
}

/** The head of an arrow: a small triangle pointing right into (x, y). */
export const arrowHead = (x: number, y: number) =>
  `M${x - ARROW_HEAD} ${y - ARROW_HEAD}L${x} ${y}L${x - ARROW_HEAD} ${y + ARROW_HEAD}Z`;

/** An arrow's ends: out of x1 on y1, into x2 on y2. */
export interface ArrowEnds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The box the arrows drawn take, with room for strokes and heads; null without arrows. */
export function arrowBox(arrows: readonly ArrowEnds[]) {
  if (!arrows.length) return null;
  const pad = ARROW_HEAD + space['0.5'];
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const { x1, y1, x2, y2 } of arrows) {
    left = Math.min(left, x1, x2 - ARROW_STUB);
    right = Math.max(right, x1 + ARROW_STUB, x2);
    top = Math.min(top, y1, y2);
    bottom = Math.max(bottom, y1, y2);
  }
  left = Math.floor(left - pad);
  top = Math.floor(top - pad);
  return { left, top, width: Math.ceil(right + pad) - left, height: Math.ceil(bottom + pad) - top };
}

/** An arrow between two rows: from a record to one that depends on it. */
export interface Edge {
  from: string;
  to: string;
  fromRow: number;
  toRow: number;
}

/** Arrows between the rows shown: from each record a row's dependency field names to that row. */
export function dependencyEdges(rows: readonly TimelineRow[], fieldId: string | undefined): Edge[] {
  if (!fieldId) return [];
  const index = new Map(rows.map((row, at) => [row.record.id, at]));
  const edges: Edge[] = [];
  rows.forEach((row, toRow) => {
    const value = row.record.values[fieldId];
    if (!Array.isArray(value)) return;
    for (const id of new Set(value)) {
      const fromRow = typeof id === 'string' ? index.get(id) : undefined;
      if (fromRow === undefined || fromRow === toRow) continue;
      edges.push({ from: id as string, to: row.record.id, fromRow, toRow });
    }
  });
  return edges;
}

/** Whether an arrow is on screen when rows `first` to `last` are. */
export const crossesRows = (edge: Edge, first: number, last: number) =>
  Math.min(edge.fromRow, edge.toRow) <= last && Math.max(edge.fromRow, edge.toRow) >= first;

// ── Dragging and nudging ────────────────────────────────

export type DragMode = 'move' | 'start' | 'end';

/** A pointer's travel in days as whole days (never -0). */
export const wholeDays = (days: number) => Math.round(days) || 0;

/** What moving a span by whole days makes of it: all of it, or one end (never past the other). */
export function dragSpan(origin: DaySpan, mode: DragMode, days: number): DaySpan {
  if (mode === 'start') return { start: Math.min(origin.start + days, origin.end), end: origin.end };
  if (mode === 'end') return { start: origin.start, end: Math.max(origin.end + days, origin.start) };
  return { start: origin.start + days, end: origin.end + days };
}

/** Which part of a bar a press `x` px from its left edge takes: an edge within `edge` px, else the bar. */
export function grabMode(x: number, width: number, edge: number): DragMode {
  if (width < edge * 3) return 'move';
  if (x <= edge) return 'start';
  if (x >= width - edge) return 'end';
  return 'move';
}

/**
 * The values that give a record a span: only fields whose day changes, and an empty start or end
 * stays empty while the span is a single day. Date-times keep their time of day (valueForDay).
 */
export function spanValues(
  record: TableRecord,
  target: DaySpan,
  start: Field,
  end: Field | undefined,
  timeZone: string,
): RecordValues {
  const values: RecordValues = {};
  const startDay = dayOf(target.start);
  const endDay = dayOf(target.end);
  const startValue = record.values[start.id];
  const before = dayOfValue(startValue, timeZone);
  const needStart = !end || !!before || startDay !== endDay;
  if (needStart && before !== startDay) values[start.id] = valueForDay(start, startDay, startValue, timeZone);
  if (!end) return values;
  const endValue = record.values[end.id];
  const after = dayOfValue(endValue, timeZone);
  if ((after || startDay !== endDay) && after !== endDay) values[end.id] = valueForDay(end, endDay, endValue, timeZone);
  return values;
}
