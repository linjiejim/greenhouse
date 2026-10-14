import { describe, expect, it } from 'vitest';
import type { Field, TableRecord } from '@greenhouse/contract';
import {
  addDays,
  dayOfValue,
  groupRecords,
  isMilestone,
  monthGrid,
  moveField,
  orderedFields,
  shiftValue,
  spanOf,
  timelineRows,
  valueForDay,
  weekStart,
} from '../model';

const field = (id: string, type: Field['type'], extra: Partial<Field> = {}): Field => ({
  id,
  table_id: 'tbl_1',
  name: id,
  type,
  config: {},
  required: false,
  is_primary: false,
  position: 0,
  ...extra,
});

const record = (id: string, values: Record<string, unknown>): TableRecord => ({
  id,
  table_id: 'tbl_1',
  values,
  revision: 1,
  created_by: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_by: null,
  updated_at: '2026-10-01T00:00:00.000Z',
});

const fields = [
  field('b', 'text', { position: 2 }),
  field('title', 'text', { is_primary: true, position: 0 }),
  field('a', 'number', { position: 1 }),
  field('c', 'date', { position: 3 }),
];

describe('fields of a view', () => {
  it('puts the primary field first, then the view’s order, then the table’s, without hidden ones', () => {
    expect(orderedFields(fields, {}).map((entry) => entry.id)).toEqual(['title', 'a', 'b', 'c']);
    expect(orderedFields(fields, { order: ['c', 'b'], hidden: ['a', 'title'] }).map((entry) => entry.id)).toEqual([
      'title',
      'c',
      'b',
    ]);
    expect(orderedFields(fields, { hidden: ['a'] }, true).map((entry) => entry.id)).toEqual(['title', 'a', 'b', 'c']);
  });

  it('moves a field one place and writes the whole order', () => {
    expect(moveField(fields, {}, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveField(fields, {}, 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveField(fields, { order: ['c'] }, 'c', 1)).toEqual(['a', 'c', 'b']);
  });
});

describe('groups', () => {
  it('splits records the server sorted into runs of one value; lists group by their first value', () => {
    const status = field('s', 'single_select');
    const groups = groupRecords(
      [record('1', { s: 'todo' }), record('2', { s: 'todo' }), record('3', {}), record('4', { s: 'done' })],
      status,
    );
    expect(groups.map((group) => [group.key, group.records.length])).toEqual([
      ['todo', 2],
      ['', 1],
      ['done', 1],
    ]);
    const owner = field('m', 'member');
    expect(groupRecords([record('1', { m: ['mbr_a', 'mbr_b'] })], owner)[0]!.key).toBe('mbr_a');
  });
});

describe('days', () => {
  it('counts days, finds Mondays and lays out a month', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(weekStart('2026-10-18')).toBe('2026-10-12');
    const grid = monthGrid('2026-10');
    expect(grid).toHaveLength(6);
    expect(grid[0]![0]).toBe('2026-09-28');
    expect(grid[0]![3]).toBe('2026-10-01');
    expect(dayOfValue('2026-10-15T17:00:00.000Z', 'Asia/Shanghai')).toBe('2026-10-16');
    expect(dayOfValue(null, 'UTC')).toBeNull();
  });
});

describe('timeline', () => {
  const start = field('start', 'date');
  const end = field('end', 'date');
  const when = field('when', 'datetime');
  const parent = field('parent', 'parent');
  const kind = field('kind', 'single_select');

  it('spans start to end; an end before the start or none is the start', () => {
    expect(spanOf(record('1', { start: '2026-10-01', end: '2026-10-05' }), start, end, 'UTC')).toEqual({
      start: '2026-10-01',
      end: '2026-10-05',
    });
    expect(spanOf(record('1', { start: '2026-10-05', end: '2026-10-01' }), start, end, 'UTC')).toEqual({
      start: '2026-10-05',
      end: '2026-10-05',
    });
    expect(spanOf(record('1', { end: '2026-10-05' }), start, end, 'UTC')).toEqual({
      start: '2026-10-05',
      end: '2026-10-05',
    });
    expect(spanOf(record('1', {}), start, end, 'UTC')).toBeNull();
  });

  it('moves dates by whole days, keeping a date-time’s time of day', () => {
    expect(shiftValue('2026-10-01', start, 3, 'UTC')).toBe('2026-10-04');
    expect(shiftValue('2026-10-01T01:30:00.000Z', when, -1, 'Asia/Shanghai')).toBe('2026-09-30T01:30:00.000Z');
    // 09:00 in Berlin stays 09:00 across the end of summer time (25 October 2026).
    expect(shiftValue('2026-10-24T07:00:15.000Z', when, 2, 'Europe/Berlin')).toBe('2026-10-26T08:00:15.000Z');
    expect(valueForDay(start, '2026-10-09', null, 'UTC')).toBe('2026-10-09');
    expect(valueForDay(when, '2026-10-09', '2026-10-01T01:30:00.000Z', 'Asia/Shanghai')).toBe(
      '2026-10-09T01:30:00.000Z',
    );
    expect(valueForDay(when, '2026-10-09', null, 'Asia/Shanghai')).toBe('2026-10-09T01:00:00.000Z');
  });

  it('orders rows by start with children under their parent, and hides children of collapsed rows', () => {
    const records = [
      record('late', { start: '2026-10-09' }),
      record('kid', { start: '2026-10-02', parent: ['early'] }),
      record('early', { start: '2026-10-01' }),
      record('none', {}),
    ];
    const spans = new Map(records.map((entry) => [entry.id, spanOf(entry, start, undefined, 'UTC')]));
    const rows = timelineRows(records, spans, parent, new Set());
    expect(rows.map((row) => [row.record.id, row.depth, row.hasChildren])).toEqual([
      ['early', 0, true],
      ['kid', 1, false],
      ['late', 0, false],
      ['none', 0, false],
    ]);
    expect(timelineRows(records, spans, parent, new Set(['early'])).map((row) => row.record.id)).toEqual([
      'early',
      'late',
      'none',
    ]);
  });

  it('still shows records whose parents point at each other', () => {
    const records = [
      record('a', { start: '2026-10-01', parent: ['b'] }),
      record('b', { start: '2026-10-02', parent: ['a'] }),
    ];
    const spans = new Map(records.map((entry) => [entry.id, spanOf(entry, start, undefined, 'UTC')]));
    expect(timelineRows(records, spans, parent, new Set()).map((row) => row.record.id)).toEqual(['a', 'b']);
  });

  it('tells milestones by an option or a checkbox', () => {
    const timeline = { start: 'start', milestone: { field: 'kind', option: 'milestone' } };
    expect(isMilestone(record('1', { kind: 'milestone' }), timeline, [kind])).toBe(true);
    expect(isMilestone(record('1', { kind: 'task' }), timeline, [kind])).toBe(false);
    const done = field('done', 'checkbox');
    expect(isMilestone(record('1', { done: true }), { start: 'start', milestone: { field: 'done' } }, [done])).toBe(
      true,
    );
  });
});
