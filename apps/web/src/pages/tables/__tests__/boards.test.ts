import { describe, expect, it } from 'vitest';
import type { Field, FieldType, RecordFile, RecordValues, TableRecord } from '@greenhouse/contract';
import {
  agendaDays,
  calendarFields,
  canSplitBy,
  cardFields,
  columnKeyOf,
  coverField,
  coverOf,
  firstDateField,
  firstKanbanField,
  hasValue,
  kanbanColumns,
  kanbanField,
  monthOf,
  moreCount,
  moveByDays,
  moveToColumn,
  newInColumn,
  newOnDay,
  placeRecords,
  shiftMonth,
  timeOfDay,
  visibleColumns,
} from '../boards-model';
import { monthGrid } from '../model';

let position = 0;
const field = (id: string, type: FieldType, extra: Partial<Field> = {}): Field => ({
  id,
  table_id: 'tbl_1',
  name: id,
  type,
  config: {},
  required: false,
  is_primary: false,
  position: position++,
  ...extra,
});

const record = (id: string, values: RecordValues = {}): TableRecord => ({
  id,
  table_id: 'tbl_1',
  values,
  revision: 1,
  computed_revision: 0,
  created_by: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_by: null,
  updated_at: '2026-10-01T00:00:00.000Z',
});

const ids = (records: readonly { id: string }[]) => records.map((entry) => entry.id);

const title = field('title', 'text', { is_primary: true });
const status = field('status', 'single_select', {
  config: {
    options: [
      { id: 'todo', label: '待处理', color: 'gray' },
      { id: 'doing', label: '进行中', color: 'blue' },
      { id: 'done', label: '已完成', color: 'green' },
    ],
  },
});
const owner = field('owner', 'member');
const owners = field('owners', 'member', { config: { multiple: true } });

describe('cards', () => {
  it('shows the visible fields after the primary, in the view order, without the skipped ones', () => {
    const a = field('a', 'text');
    const b = field('b', 'number');
    const c = field('c', 'date');
    const d = field('d', 'url');
    const e = field('e', 'checkbox');
    const f = field('f', 'single_select');
    const fields = [title, a, b, c, d, e, f];
    const config = { hidden: ['b'], order: ['c', 'a'] };
    expect(ids(cardFields(fields, config))).toEqual(['c', 'a', 'd', 'e']);
    expect(ids(cardFields(fields, config, ['d', undefined]))).toEqual(['c', 'a', 'e', 'f']);
    expect(ids(cardFields(fields, config, [], { limit: 2 }))).toEqual(['c', 'a']);
    // Without a view order, the table's order.
    expect(ids(cardFields([title, f, a, owners, owner], {}, [], { types: ['single_select', 'member'] }))).toEqual([
      'owner',
      'owners',
      'f',
    ]);
  });

  it('counts a ticked checkbox and zero as values, not empty text or lists', () => {
    const check = field('check', 'checkbox');
    const number = field('number', 'number');
    expect(hasValue(check, true)).toBe(true);
    expect(hasValue(check, false)).toBe(false);
    expect(hasValue(number, 0)).toBe(true);
    expect(hasValue(number, null)).toBe(false);
    expect(hasValue(owner, [])).toBe(false);
    expect(hasValue(title, '')).toBe(false);
  });

  it('shows the next page, or what is left', () => {
    expect(moreCount(250, 100, 100)).toBe(100);
    expect(moreCount(150, 100, 100)).toBe(50);
    expect(moreCount(100, 100, 100)).toBe(0);
    expect(moreCount(40, 100, 100)).toBe(0);
  });
});

describe('kanban', () => {
  const names: Record<string, string> = { mbr_b: 'Bo', mbr_a: 'Al', mbr_c: 'Cy' };
  const nameOf = (id: string) => names[id];

  it('splits by a single select or a single member field only', () => {
    expect(canSplitBy(status)).toBe(true);
    expect(canSplitBy(owner)).toBe(true);
    expect(canSplitBy(owners)).toBe(false);
    expect(canSplitBy(title)).toBe(false);
    const fields = [title, owners, owner, status];
    expect(kanbanField(fields, { kanban: { field: 'status' } })).toBe(status);
    expect(kanbanField(fields, { kanban: { field: 'owners' } })).toBeUndefined();
    expect(kanbanField(fields, { kanban: { field: 'gone' } })).toBeUndefined();
    expect(kanbanField(fields, {})).toBeUndefined();
    expect(firstKanbanField(fields)).toBe(status);
    expect(firstKanbanField([title, owners, owner])).toBe(owner);
    expect(firstKanbanField([title, owners])).toBeUndefined();
  });

  it('makes a column per option in option order, after 「（无）」, keeping the view order', () => {
    const records = [
      record('r1', { status: 'done' }),
      record('r2', { status: 'todo' }),
      record('r3', {}),
      record('r4', { status: 'gone_option' }),
      record('r5', { status: 'todo' }),
    ];
    const columns = kanbanColumns(status, records, nameOf);
    expect(columns.map((column) => column.key)).toEqual(['', 'todo', 'doing', 'done']);
    expect(columns.map((column) => ids(column.records))).toEqual([['r3', 'r4'], ['r2', 'r5'], [], ['r1']]);
    expect(columns[1]!.option?.label).toBe('待处理');
    expect(visibleColumns(columns, true).map((column) => column.key)).toEqual(['', 'todo', 'done']);
    expect(visibleColumns(columns, false)).toHaveLength(4);
    // A phone leaves out an empty 「（无）」, not other empty columns.
    const none = kanbanColumns(status, [record('r1', { status: 'done' })], nameOf);
    expect(visibleColumns(none, false, true).map((column) => column.key)).toEqual(['todo', 'doing', 'done']);
    expect(visibleColumns(none, false, false).map((column) => column.key)).toEqual(['', 'todo', 'doing', 'done']);
  });

  it('makes a column per member who appears, by name, unknown members last', () => {
    const records = [
      record('r1', { owner: ['mbr_b'] }),
      record('r2', { owner: ['mbr_x'] }),
      record('r3', { owner: [] }),
      record('r4', { owner: ['mbr_a'] }),
      record('r5', { owner: ['mbr_b', 'mbr_c'] }),
      record('r6', {}),
    ];
    const columns = kanbanColumns(owner, records, nameOf);
    expect(columns.map((column) => column.key)).toEqual(['', 'mbr_a', 'mbr_b', 'mbr_x']);
    expect(columns.map((column) => ids(column.records))).toEqual([['r3', 'r6'], ['r4'], ['r1', 'r5'], ['r2']]);
    expect(visibleColumns(kanbanColumns(owner, [record('r1', { owner: ['mbr_a'] })], nameOf), true)).toHaveLength(1);
  });

  it('knows which column a record is in', () => {
    expect(columnKeyOf(status, record('r', { status: 'doing' }))).toBe('doing');
    expect(columnKeyOf(status, record('r', { status: 'gone_option' }))).toBe('');
    expect(columnKeyOf(status, record('r', {}))).toBe('');
    expect(columnKeyOf(owner, record('r', { owner: ['mbr_a', 'mbr_b'] }))).toBe('mbr_a');
    expect(columnKeyOf(owner, record('r', { owner: [] }))).toBe('');
  });

  it('writes the option or the member of the column a card moves to, nothing for its own', () => {
    expect(moveToColumn(status, record('r', { status: 'todo' }), 'done')).toEqual({ status: 'done' });
    expect(moveToColumn(status, record('r', { status: 'todo' }), '')).toEqual({ status: null });
    expect(moveToColumn(status, record('r', { status: 'todo' }), 'todo')).toBeNull();
    expect(moveToColumn(status, record('r', { status: 'gone_option' }), '')).toBeNull();
    expect(moveToColumn(owner, record('r', { owner: ['mbr_a'] }), 'mbr_b')).toEqual({ owner: ['mbr_b'] });
    expect(moveToColumn(owner, record('r', { owner: ['mbr_a'] }), '')).toEqual({ owner: [] });
    expect(moveToColumn(owner, record('r', {}), '')).toBeNull();
  });

  it('adds a record with its column value, or none in 「（无）」', () => {
    expect(newInColumn(status, 'doing')).toEqual({ status: 'doing' });
    expect(newInColumn(owner, 'mbr_a')).toEqual({ owner: ['mbr_a'] });
    expect(newInColumn(status, '')).toEqual({});
  });
});

describe('calendar', () => {
  const start = field('start', 'date');
  const due = field('due', 'date');
  const at = field('at', 'datetime');

  it('needs a date or date-time start; an end only when it is another date field', () => {
    const fields = [title, status, start, due, at];
    expect(calendarFields(fields, {})).toBeNull();
    expect(calendarFields(fields, { calendar: { start: 'status' } })).toBeNull();
    expect(calendarFields(fields, { calendar: { start: 'gone' } })).toBeNull();
    expect(calendarFields(fields, { calendar: { start: 'start' } })).toEqual({ start });
    expect(calendarFields(fields, { calendar: { start: 'start', end: 'at' } })).toEqual({ start, end: at });
    expect(calendarFields(fields, { calendar: { start: 'start', end: 'start' } })).toEqual({ start });
    expect(calendarFields(fields, { calendar: { start: 'start', end: 'status' } })).toEqual({ start });
    expect(firstDateField(fields)).toBe(start);
    expect(firstDateField([title, at, start])).toBe(at);
    expect(firstDateField([title, status])).toBeUndefined();
  });

  it('moves between months across years', () => {
    expect(shiftMonth('2026-10', 1)).toBe('2026-11');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-10', -14)).toBe('2025-08');
    expect(monthOf('2026-10-16')).toBe('2026-10');
  });

  it('puts a record on every shown day from its start to its end', () => {
    const days = monthGrid('2026-10').flat();
    expect(days[0]).toBe('2026-09-28');
    expect(days.at(-1)).toBe('2026-11-08');
    const records = [
      record('one', { start: '2026-10-16' }),
      record('span', { start: '2026-10-14', due: '2026-10-17' }),
      record('back', { start: '2026-10-20', due: '2026-10-18' }),
      record('long', { start: '2026-09-01', due: '2026-09-29' }),
      record('outside', { start: '2026-12-01' }),
      record('none', {}),
      record('endOnly', { due: '2026-10-05' }),
    ];
    const placed = placeRecords(records, start, due, 'UTC', days);
    const on = (day: string) => ids((placed.get(day) ?? []).map((entry) => entry.record));
    expect(on('2026-10-13')).toEqual([]);
    expect(on('2026-10-14')).toEqual(['span']);
    expect(on('2026-10-16')).toEqual(['span', 'one']);
    expect(on('2026-10-17')).toEqual(['span']);
    expect(on('2026-10-18')).toEqual([]);
    expect(on('2026-10-20')).toEqual(['back']);
    expect(on('2026-09-28')).toEqual(['long']);
    expect(on('2026-09-29')).toEqual(['long']);
    expect(on('2026-09-30')).toEqual([]);
    expect(on('2026-10-05')).toEqual(['endOnly']);
    expect([...placed.values()].flat().some((entry) => entry.record.id === 'outside')).toBe(false);
    expect(placed.get('2026-10-15')![0]!.span).toEqual({ start: '2026-10-14', end: '2026-10-17' });

    const startOnly = placeRecords(records, start, undefined, 'UTC', days);
    expect(ids((startOnly.get('2026-10-15') ?? []).map((entry) => entry.record))).toEqual([]);
    expect(ids((startOnly.get('2026-10-14') ?? []).map((entry) => entry.record))).toEqual(['span']);
  });

  it('lists earlier starts first, then by time of day, then in the view order', () => {
    const days = monthGrid('2026-10').flat();
    const records = [
      record('late', { at: '2026-10-16T06:00:00.000Z' }),
      record('early', { at: '2026-10-16T01:00:00.000Z' }),
      record('evening', { at: '2026-10-15T20:00:00.000Z' }),
    ];
    const shanghai = placeRecords(records, at, undefined, 'Asia/Shanghai', days);
    // 20:00 UTC on the 15th is 04:00 on the 16th in Shanghai.
    expect(ids(shanghai.get('2026-10-16')!.map((entry) => entry.record))).toEqual(['evening', 'early', 'late']);
    const utc = placeRecords(records, at, undefined, 'UTC', days);
    expect(ids(utc.get('2026-10-15')!.map((entry) => entry.record))).toEqual(['evening']);
    expect(ids(utc.get('2026-10-16')!.map((entry) => entry.record))).toEqual(['early', 'late']);

    const dates = [record('b', { start: '2026-10-16' }), record('a', { start: '2026-10-16' })];
    expect(
      ids(
        placeRecords(dates, start, undefined, 'UTC', days)
          .get('2026-10-16')!
          .map((entry) => entry.record),
      ),
    ).toEqual(['b', 'a']);
  });

  it('lists the month days that have records, in order', () => {
    const days = monthGrid('2026-10').flat();
    const records = [
      record('r1', { start: '2026-10-20' }),
      record('r2', { start: '2026-09-29' }),
      record('r3', { start: '2026-10-02' }),
      record('r4', { start: '2026-11-02' }),
    ];
    const placed = placeRecords(records, start, undefined, 'UTC', days);
    expect(agendaDays(placed, days, '2026-10')).toEqual(['2026-10-02', '2026-10-20']);
  });

  it('moves the start and the end by the same days, date-times keeping their time', () => {
    const moved = record('r', { start: '2026-10-16', due: '2026-10-20' });
    expect(moveByDays(moved, start, due, 2, 'UTC')).toEqual({ start: '2026-10-18', due: '2026-10-22' });
    expect(moveByDays(moved, start, due, -16, 'UTC')).toEqual({ start: '2026-09-30', due: '2026-10-04' });
    expect(moveByDays(moved, start, undefined, 1, 'UTC')).toEqual({ start: '2026-10-17' });
    expect(moveByDays(moved, start, due, 0, 'UTC')).toBeNull();
    expect(moveByDays(record('r', { start: '2026-10-16' }), start, due, 1, 'UTC')).toEqual({ start: '2026-10-17' });
    expect(moveByDays(record('r', { due: '2026-10-16' }), start, due, 1, 'UTC')).toEqual({ due: '2026-10-17' });
    expect(moveByDays(record('r', {}), start, due, 1, 'UTC')).toBeNull();
    expect(moveByDays(record('r', { at: '2026-10-16T01:30:00.000Z' }), at, undefined, 1, 'UTC')).toEqual({
      at: '2026-10-17T01:30:00.000Z',
    });
  });

  it('adds a record on a day, a date-time at 09:00 in the reader’s zone', () => {
    expect(newOnDay(start, '2026-10-16', 'Asia/Shanghai')).toEqual({ start: '2026-10-16' });
    expect(newOnDay(at, '2026-10-16', 'Asia/Shanghai')).toEqual({ at: '2026-10-16T01:00:00.000Z' });
    expect(newOnDay(at, '2026-10-16', 'UTC')).toEqual({ at: '2026-10-16T09:00:00.000Z' });
  });

  it('shows the time of a date-time in the reader’s zone, nothing for dates', () => {
    expect(timeOfDay(at, '2026-10-16T01:30:00.000Z', 'Asia/Shanghai')).toBe('09:30');
    expect(timeOfDay(at, '2026-10-16T01:30:00.000Z', 'UTC')).toBe('01:30');
    expect(timeOfDay(at, null, 'UTC')).toBe('');
    expect(timeOfDay(start, '2026-10-16', 'UTC')).toBe('');
  });
});

describe('gallery', () => {
  const files = field('files', 'attachment');
  const file = (id: string, contentType: string): RecordFile => ({
    id,
    name: `${id}.bin`,
    content_type: contentType,
    size_bytes: 1,
    url: `https://files.example/${id}`,
  });
  const stored: Record<string, RecordFile> = {
    f_pdf: file('f_pdf', 'application/pdf'),
    f_png: file('f_png', 'image/png'),
    f_jpg: file('f_jpg', 'image/jpeg'),
  };
  const fileOf = (id: string) => stored[id];

  it('covers with an attachment field only', () => {
    expect(coverField([title, files, status], { gallery: { cover: 'files' } })).toBe(files);
    expect(coverField([title, files, status], { gallery: { cover: 'status' } })).toBeUndefined();
    expect(coverField([title, files], { gallery: {} })).toBeUndefined();
    expect(coverField([title, files], {})).toBeUndefined();
  });

  it('takes the first picture of the cover field', () => {
    expect(coverOf(record('r', { files: ['f_missing', 'f_pdf', 'f_png', 'f_jpg'] }), files, fileOf)?.id).toBe('f_png');
    expect(coverOf(record('r', { files: ['f_pdf'] }), files, fileOf)).toBeUndefined();
    expect(coverOf(record('r', {}), files, fileOf)).toBeUndefined();
    expect(coverOf(record('r', { files: ['f_png'] }), undefined, fileOf)).toBeUndefined();
  });
});
