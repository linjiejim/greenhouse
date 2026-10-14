import { describe, expect, it } from 'vitest';
import type { Field, TableRecord } from '@greenhouse/contract';
import { dayNumber as d, isMilestone, spanOf, timelineRows, type Span } from '../model';
import {
  anchorsOf,
  arrowBox,
  arrowHead,
  arrowPath,
  axisCells,
  barBox,
  centerDayAt,
  crossesRows,
  dayWindow,
  defaultTimeline,
  dependencyEdges,
  dragSpan,
  grabMode,
  initialDay,
  pageAt,
  recordSpan,
  rowStepAt,
  rowWindow,
  scrollLeftFor,
  scrollLeftForCenter,
  spanValues,
  timelineRange,
  timelineSetup,
  unitNext,
  unitStart,
  weekdayOf,
  wholeDays,
  type DaySpan,
} from '../timeline-model';

const field = (id: string, type: Field['type'], extra: Partial<Field> = {}): Field => ({
  id,
  table_id: 'tbl',
  name: id,
  type,
  config: {},
  required: false,
  is_primary: false,
  position: 0,
  ...extra,
});

const record = (id: string, values: TableRecord['values'] = {}): TableRecord => ({
  id,
  table_id: 'tbl',
  values,
  revision: 1,
  created_by: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_by: null,
  updated_at: '2026-10-01T00:00:00.000Z',
});

const span = (start: string, end = start): DaySpan => ({ start: d(start), end: d(end) });

const title = field('title', 'text', { is_primary: true });
const start = field('start', 'date');
const due = field('due', 'date');
const startTime = field('start_time', 'datetime');
const parent = field('parent', 'parent');
const depends = field('depends', 'dependency');
const kind = field('kind', 'single_select', {
  config: {
    options: [
      { id: 'task', label: 'Task', color: 'blue' },
      { id: 'milestone', label: 'Milestone', color: 'purple' },
    ],
  },
});
const done = field('done', 'checkbox');
const fields = [title, start, due, startTime, parent, depends, kind, done];

describe('timeline setup', () => {
  it('needs a start field that is a date', () => {
    expect(timelineSetup({}, fields)).toBeNull();
    expect(timelineSetup({ timeline: { start: 'gone' } }, fields)).toBeNull();
    expect(timelineSetup({ timeline: { start: 'title' } }, fields)).toBeNull();
  });

  it('finds the end, dependency and parent fields and ignores ones that do not fit', () => {
    const setup = timelineSetup({ timeline: { start: 'start', end: 'due', dependency: 'depends' } }, fields)!;
    expect(setup.start).toBe(start);
    expect(setup.end).toBe(due);
    expect(setup.dependency).toBe(depends);
    expect(setup.parent).toBe(parent);
    const odd = timelineSetup({ timeline: { start: 'start_time', end: 'start_time', dependency: 'parent' } }, fields)!;
    expect(odd.start).toBe(startTime);
    expect(odd.end).toBeUndefined();
    expect(odd.dependency).toBeUndefined();
    expect(timelineSetup({ timeline: { start: 'start', end: 'kind' } }, fields)!.end).toBeUndefined();
  });

  it('sets a timeline up by the first date field, by week', () => {
    expect(defaultTimeline({ hidden: ['x'] }, [title, startTime, start])).toEqual({
      hidden: ['x'],
      timeline: { start: 'start_time', scale: 'week' },
    });
    expect(defaultTimeline({}, [title, kind])).toBeNull();
  });
});

describe('spans by record', () => {
  it('works a span out once per record object and setup', () => {
    const item = record('r', { start: '2026-10-12', due: '2026-10-16' });
    const first = recordSpan(item, start, due, 'Asia/Shanghai');
    expect(first).toEqual({
      span: { start: '2026-10-12', end: '2026-10-16' },
      days: { start: d('2026-10-12'), end: d('2026-10-16') },
    });
    expect(recordSpan(item, start, due, 'Asia/Shanghai')).toBe(first);
    expect(recordSpan(item, start, undefined, 'Asia/Shanghai')!.days).toEqual(span('2026-10-12'));
    const saved = { ...item, values: { ...item.values, due: '2026-10-20' } };
    expect(recordSpan(saved, start, due, 'Asia/Shanghai')!.days).toEqual(span('2026-10-12', '2026-10-20'));
    expect(recordSpan(record('u'), start, due, 'Asia/Shanghai')).toBeNull();
  });
});

describe('days and units', () => {
  it('counts weekdays from Monday, before 1970 too', () => {
    expect(weekdayOf(d('2026-10-12'))).toBe(0);
    expect(weekdayOf(d('2026-10-18'))).toBe(6);
    expect(weekdayOf(d('1970-01-01'))).toBe(3);
    expect(weekdayOf(d('1969-12-29'))).toBe(0);
  });

  it('finds where weeks, months and years start and end', () => {
    expect(unitStart('week', d('2026-10-14'))).toBe(d('2026-10-12'));
    expect(unitStart('week', d('2026-10-18'))).toBe(d('2026-10-12'));
    expect(unitNext('week', d('2026-10-18'))).toBe(d('2026-10-19'));
    expect(unitStart('month', d('2026-10-14'))).toBe(d('2026-10-01'));
    expect(unitNext('month', d('2026-12-15'))).toBe(d('2027-01-01'));
    expect(unitStart('year', d('2026-10-14'))).toBe(d('2026-01-01'));
    expect(unitNext('year', d('2026-10-14'))).toBe(d('2027-01-01'));
    expect(unitNext('day', d('2026-10-31'))).toBe(d('2026-11-01'));
  });
});

describe('the days a timeline covers', () => {
  const spans = [span('2026-10-12', '2026-10-20'), null];

  it('covers the records and today with a margin, in whole weeks', () => {
    const range = timelineRange(spans, d('2026-10-14'), 'week');
    expect(range).toEqual({ from: d('2026-09-07'), to: d('2026-11-29') });
    expect(weekdayOf(range.from)).toBe(0);
    expect(weekdayOf(range.to)).toBe(6);
  });

  it('always includes today', () => {
    const range = timelineRange(spans, d('2027-03-03'), 'day');
    expect(range.from).toBeLessThanOrEqual(d('2026-10-12'));
    expect(range.to).toBeGreaterThanOrEqual(d('2027-03-03'));
    expect(timelineRange([], d('2026-10-14'), 'day')).toEqual({ from: d('2026-09-28'), to: d('2026-11-01') });
  });

  it('is at least as long as the screen, still ending on a Sunday', () => {
    const range = timelineRange(spans, d('2026-10-14'), 'week', 200);
    expect(range.from).toBe(d('2026-09-07'));
    expect(range.to - range.from + 1).toBeGreaterThanOrEqual(200);
    expect(range.to - range.from + 1).toBeLessThan(207);
    expect(weekdayOf(range.to)).toBe(6);
  });

  it('runs whole months on the month scale', () => {
    expect(timelineRange(spans, d('2026-10-14'), 'month')).toEqual({ from: d('2026-06-01'), to: d('2027-02-28') });
  });

  it('opens on today while the records run through it, else where they begin', () => {
    expect(initialDay([], d('2026-10-14'))).toBe(d('2026-10-14'));
    expect(initialDay(spans, d('2026-10-14'))).toBe(d('2026-10-14'));
    expect(initialDay(spans, d('2026-12-01'))).toBe(d('2026-10-12'));
    expect(initialDay([span('2027-01-04', '2027-02-01')], d('2026-10-14'))).toBe(d('2027-01-04'));
  });
});

describe('the axis', () => {
  it('has a cell per day', () => {
    const cells = axisCells('day', { from: d('2026-10-12'), to: d('2026-10-18') }, d('2026-10-12'), d('2026-10-14'));
    expect(cells.map((cell) => [cell.start, cell.end, cell.date])).toEqual([
      [d('2026-10-12'), d('2026-10-12'), 12],
      [d('2026-10-13'), d('2026-10-13'), 13],
      [d('2026-10-14'), d('2026-10-14'), 14],
    ]);
  });

  it('labels weeks by their Monday', () => {
    const cells = axisCells('week', { from: d('2026-09-28'), to: d('2026-10-25') }, d('2026-10-01'), d('2026-10-13'));
    expect(cells.map((cell) => [cell.start, cell.end, cell.month, cell.date])).toEqual([
      [d('2026-09-28'), d('2026-10-04'), 9, 28],
      [d('2026-10-05'), d('2026-10-11'), 10, 5],
      [d('2026-10-12'), d('2026-10-18'), 10, 12],
    ]);
  });

  it('cuts months and years to the range', () => {
    const months = axisCells('month', { from: d('2026-09-28'), to: d('2026-11-08') }, d('2026-09-28'), d('2026-11-08'));
    expect(months.map((cell) => [cell.start, cell.end, cell.year, cell.month])).toEqual([
      [d('2026-09-28'), d('2026-09-30'), 2026, 9],
      [d('2026-10-01'), d('2026-10-31'), 2026, 10],
      [d('2026-11-01'), d('2026-11-08'), 2026, 11],
    ]);
    const years = axisCells('year', { from: d('2026-06-01'), to: d('2027-02-28') }, d('2026-06-01'), d('2027-02-28'));
    expect(years.map((cell) => [cell.start, cell.end, cell.year])).toEqual([
      [d('2026-06-01'), d('2026-12-31'), 2026],
      [d('2027-01-01'), d('2027-02-28'), 2027],
    ]);
  });
});

describe('what to draw at a scroll position', () => {
  it('draws the rows in view and a few more, in steps', () => {
    expect(rowWindow(0, 400, 36, 1000)).toEqual({ first: 0, last: 24 });
    expect(rowWindow(10, 400, 36, 1000)).toEqual({ first: 76, last: 104 });
    expect(rowWindow(5, 400, 36, 10)).toEqual({ first: 5, last: 9 });
    expect(rowWindow(0, 400, 36, 0)).toEqual({ first: 0, last: -1 });
  });

  it('never leaves a row in view undrawn', () => {
    const rows = 1000;
    const viewport = 400;
    for (let top = 0; top <= rows * 36 - viewport; top += 7) {
      const window = rowWindow(rowStepAt(top, 36), viewport, 36, rows);
      expect(window.first).toBeLessThanOrEqual(Math.floor(top / 36));
      expect(window.last).toBeGreaterThanOrEqual(Math.min(rows - 1, Math.floor((top + viewport - 1) / 36)));
    }
  });

  it('never leaves a day in view without its header cell', () => {
    const total = 500;
    const width = 1000;
    for (let left = 0; left <= total * 18 - width; left += 13) {
      const window = dayWindow(pageAt(left, width), width, 18, total);
      expect(window.first).toBeLessThanOrEqual(Math.floor(left / 18));
      expect(window.last).toBeGreaterThanOrEqual(Math.min(total - 1, Math.floor((left + width - 1) / 18)));
    }
  });

  it('scrolls a day into place and keeps the middle when the scale changes', () => {
    const from = d('2026-09-07');
    expect(scrollLeftFor(from + 10, from, 40, 800)).toBe(20);
    expect(scrollLeftFor(from + 1, from, 40, 800)).toBe(0);
    expect(centerDayAt(20, from, 40, 800)).toBe(from + 10.5);
    expect(scrollLeftForCenter(from + 100.5, from, 18, 800)).toBe(1409);
    expect(centerDayAt(1409, from, 18, 800)).toBeCloseTo(from + 100.5, 1);
  });
});

describe('bars, milestones and arrows', () => {
  const from = d('2026-10-12');

  it('places bars by day, never thinner than a few pixels', () => {
    expect(barBox({ start: from + 2, end: from + 4 }, from, 40)).toEqual({ left: 80, width: 120 });
    expect(barBox({ start: from + 2, end: from + 2 }, from, 5)).toEqual({ left: 10, width: 8 });
  });

  it('starts and ends arrows at a milestone diamond or a bar edge', () => {
    expect(anchorsOf({ start: from + 3, end: from + 3 }, true, from, 40)).toEqual({ left: 132, right: 148 });
    expect(anchorsOf({ start: from + 1, end: from + 2 }, false, from, 40)).toEqual({ left: 40, right: 120 });
  });

  it('draws arrows in right angles, around when the target starts too early', () => {
    expect(arrowPath(100, 18, 200, 90, 36)).toBe('M100 18H108V90H200');
    expect(arrowPath(100, 18, 104, 90, 36)).toBe('M100 18H108V72H96V90H104');
    expect(arrowPath(100, 90, 104, 18, 36)).toBe('M100 90H108V36H96V18H104');
    expect(arrowHead(50, 20)).toBe('M46 16L50 20L46 24Z');
  });

  it('draws arrows in a box only as big as they are', () => {
    expect(arrowBox([])).toBeNull();
    expect(arrowBox([{ x1: 100, y1: 18, x2: 200, y2: 90 }])).toEqual({ left: 94, top: 12, width: 112, height: 84 });
    expect(
      arrowBox([
        { x1: 100, y1: 90, x2: 104, y2: 18 },
        { x1: 300, y1: 126, x2: 340, y2: 162 },
      ]),
    ).toEqual({ left: 90, top: 12, width: 256, height: 156 });
  });

  it('finds arrows from the records a row depends on', () => {
    const rows = [
      { record: record('a'), depth: 0, hasChildren: false },
      { record: record('b', { depends: ['a'] }), depth: 0, hasChildren: false },
      { record: record('c', { depends: ['a', 'b', 'a', 'gone', 'c'] }), depth: 0, hasChildren: false },
    ];
    expect(dependencyEdges(rows, 'depends')).toEqual([
      { from: 'a', to: 'b', fromRow: 0, toRow: 1 },
      { from: 'a', to: 'c', fromRow: 0, toRow: 2 },
      { from: 'b', to: 'c', fromRow: 1, toRow: 2 },
    ]);
    expect(dependencyEdges(rows, undefined)).toEqual([]);
  });

  it('draws only arrows that cross the rows on screen', () => {
    const edge = (fromRow: number, toRow: number) => ({ from: 'a', to: 'b', fromRow, toRow });
    expect(crossesRows(edge(2, 50), 10, 20)).toBe(true);
    expect(crossesRows(edge(25, 20), 10, 20)).toBe(true);
    expect(crossesRows(edge(0, 5), 10, 20)).toBe(false);
    expect(crossesRows(edge(30, 25), 10, 20)).toBe(false);
  });
});

describe('dragging', () => {
  it('rounds a drag to whole days', () => {
    expect(Object.is(wholeDays(-0.4), 0)).toBe(true);
    expect(wholeDays(1.6)).toBe(2);
    expect(wholeDays(-1.6)).toBe(-2);
  });

  it('moves a span, or one end without passing the other', () => {
    const origin = { start: 10, end: 14 };
    expect(dragSpan(origin, 'move', 3)).toEqual({ start: 13, end: 17 });
    expect(dragSpan(origin, 'start', 2)).toEqual({ start: 12, end: 14 });
    expect(dragSpan(origin, 'start', 9)).toEqual({ start: 14, end: 14 });
    expect(dragSpan(origin, 'end', -2)).toEqual({ start: 10, end: 12 });
    expect(dragSpan(origin, 'end', -9)).toEqual({ start: 10, end: 10 });
  });

  it('grabs an edge near the ends of a wide bar, else the bar', () => {
    expect(grabMode(3, 100, 8)).toBe('start');
    expect(grabMode(95, 100, 8)).toBe('end');
    expect(grabMode(50, 100, 8)).toBe('move');
    expect(grabMode(2, 20, 8)).toBe('move');
  });
});

describe('the values a new span saves', () => {
  const zone = 'Asia/Shanghai';

  it('moves both dates', () => {
    const item = record('r', { start: '2026-10-12', due: '2026-10-16' });
    expect(spanValues(item, span('2026-10-14', '2026-10-18'), start, due, zone)).toEqual({
      start: '2026-10-14',
      due: '2026-10-18',
    });
    expect(spanValues(item, span('2026-10-12', '2026-10-16'), start, due, zone)).toEqual({});
  });

  it('keeps an empty end empty until the span needs one', () => {
    const item = record('r', { start: '2026-10-12' });
    expect(spanValues(item, span('2026-10-13'), start, due, zone)).toEqual({ start: '2026-10-13' });
    expect(spanValues(item, span('2026-10-12', '2026-10-15'), start, due, zone)).toEqual({ due: '2026-10-15' });
    expect(spanValues(item, span('2026-10-15'), start, undefined, zone)).toEqual({ start: '2026-10-15' });
  });

  it('keeps an empty start empty until the span needs one', () => {
    const item = record('r', { due: '2026-10-16' });
    expect(spanValues(item, span('2026-10-17'), start, due, zone)).toEqual({ due: '2026-10-17' });
    expect(spanValues(item, span('2026-10-14', '2026-10-16'), start, due, zone)).toEqual({ start: '2026-10-14' });
  });

  it('keeps the time of day of a date-time, or starts it at 09:00', () => {
    const item = record('r', { start_time: '2026-10-12T06:30:00.000Z', due: '2026-10-16' });
    expect(spanValues(item, span('2026-10-14', '2026-10-18'), startTime, due, zone)).toEqual({
      start_time: '2026-10-14T06:30:00.000Z',
      due: '2026-10-18',
    });
    const open = record('r', { due: '2026-10-16' });
    expect(spanValues(open, span('2026-10-14', '2026-10-16'), startTime, due, zone)).toEqual({
      start_time: '2026-10-14T01:00:00.000Z',
    });
  });
});

describe('rows and milestones (model.ts)', () => {
  const items = [
    record('p', { title: 'Project', start: '2026-10-12' }),
    record('c1', { title: 'Late child', start: '2026-10-15', parent: ['p'] }),
    record('c2', { title: 'Early child', start: '2026-10-13', parent: ['p'] }),
    record('r', { title: 'First', start: '2026-10-10' }),
    record('u', { title: 'Unscheduled' }),
    record('o', { title: 'Orphan', start: '2026-10-11', parent: ['filtered-out'] }),
  ];
  const spans = new Map<string, Span | null>(items.map((item) => [item.id, spanOf(item, start, due, 'Asia/Shanghai')]));

  it('orders by start, children right after their parent, records without dates last', () => {
    const rows = timelineRows(items, spans, parent, new Set());
    expect(rows.map((row) => [row.record.id, row.depth, row.hasChildren])).toEqual([
      ['r', 0, false],
      ['o', 0, false],
      ['p', 0, true],
      ['c2', 1, false],
      ['c1', 1, false],
      ['u', 0, false],
    ]);
  });

  it('leaves out the children of a collapsed record', () => {
    const rows = timelineRows(items, spans, parent, new Set(['p']));
    expect(rows.map((row) => row.record.id)).toEqual(['r', 'o', 'p', 'u']);
    expect(rows[2]!.hasChildren).toBe(true);
  });

  it('knows milestones by an option or a ticked checkbox', () => {
    const byOption = { start: 'start', milestone: { field: 'kind', option: 'milestone' } };
    expect(isMilestone(record('m', { kind: 'milestone' }), byOption, fields)).toBe(true);
    expect(isMilestone(record('t', { kind: 'task' }), byOption, fields)).toBe(false);
    const byCheck = { start: 'start', milestone: { field: 'done' } };
    expect(isMilestone(record('m', { done: true }), byCheck, fields)).toBe(true);
    expect(isMilestone(record('t', {}), byCheck, fields)).toBe(false);
    expect(isMilestone(record('m', { kind: 'milestone' }), { start: 'start' }, fields)).toBe(false);
  });
});
