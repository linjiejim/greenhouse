/**
 * The pure parts of the view bodies: what each type adds to the record query,
 * the calendar's window and month grid, kanban lanes, and group keys that
 * match the server's aggregate groups.
 */

import { describe, expect, it } from 'vitest';
import { fixtureField, fixtureRecord } from './view-test-fixtures';
import {
  addDays,
  calendarWindowFilters,
  countsByGroup,
  dayOfValue,
  daysBetween,
  dayStart,
  kanbanLanes,
  localDay,
  monthGridDays,
  recordGroupKey,
  recordLaneKey,
  shiftMonth,
  viewQueryShape,
  VIEW_RECORD_LIMIT,
  weekStartFor,
} from './view-query';

const stage = fixtureField(2, 'Stage', 'single_select', {
  options: [
    { id: 'lead', label: 'Lead' },
    { id: 'won', label: 'Won' },
  ],
});
const owner = fixtureField(3, 'Owner', 'user');
const due = fixtureField(4, 'Due', 'date');
const ends = fixtureField(5, 'Ends', 'datetime');

describe('month grid', () => {
  it('lays out six weeks starting on the locale’s first weekday', () => {
    // October 2026 starts on a Thursday.
    const sunday = monthGridDays('2026-10', 0);
    expect(sunday).toHaveLength(42);
    expect(sunday[0]).toBe('2026-09-27');
    expect(sunday[41]).toBe('2026-11-07');
    const monday = monthGridDays('2026-10', 1);
    expect(monday[0]).toBe('2026-09-28');
    expect(weekStartFor('zh')).toBe(1);
    expect(weekStartFor('en')).toBe(0);
  });

  it('moves by months and days in local time', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(daysBetween('2026-10-30', '2026-11-02')).toBe(3);
    expect(localDay(dayStart('2026-03-08'))).toBe('2026-03-08');
    expect(dayOfValue('2026-10-14', 'date')).toBe('2026-10-14');
    expect(dayOfValue('not a date', 'datetime')).toBeNull();
    expect(dayOfValue(dayStart('2026-10-14').toISOString(), 'datetime')).toBe('2026-10-14');
  });
});

describe('viewQueryShape', () => {
  it('adds grouping to a grid, a cap to kanban, a window to a calendar, nothing to a gallery', () => {
    const calendar = { month: '2026-10', weekStart: 0 as const };
    expect(viewQueryShape('grid', {}, [stage], calendar)).toEqual({});
    expect(viewQueryShape('grid', { groupBy: { fieldId: stage.id } }, [stage], calendar)).toEqual({
      groupBy: { fieldId: stage.id },
    });
    // A grouping whose field is gone is ignored rather than failing the query.
    expect(viewQueryShape('grid', { groupBy: { fieldId: 99 } }, [stage], calendar)).toEqual({});
    expect(viewQueryShape('grid', { groupBy: { systemField: 'created_by' } }, [], calendar)).toEqual({
      groupBy: { systemField: 'created_by' },
    });
    expect(viewQueryShape('kanban', { kanban: { groupFieldId: stage.id } }, [stage], calendar)).toEqual({
      limit: VIEW_RECORD_LIMIT,
    });
    expect(viewQueryShape('gallery', {}, [stage], calendar)).toEqual({});
    const shaped = viewQueryShape('calendar', { calendar: { startFieldId: due.id } }, [due], calendar);
    expect(shaped.limit).toBe(VIEW_RECORD_LIMIT);
    expect(shaped.filters).toEqual([
      { combinator: 'and', clauses: [{ fieldId: due.id, operator: 'lte', value: '2026-11-07' }] },
      { combinator: 'and', clauses: [{ fieldId: due.id, operator: 'gte', value: '2026-09-27' }] },
    ]);
  });

  it('includes records that start before the window and end inside it', () => {
    const filters = calendarWindowFilters(due, ends, '2026-09-27', '2026-11-07');
    expect(filters[0]).toEqual({
      combinator: 'and',
      clauses: [{ fieldId: due.id, operator: 'lte', value: '2026-11-07' }],
    });
    expect(filters[1]).toEqual({
      combinator: 'or',
      clauses: [
        { fieldId: due.id, operator: 'gte', value: '2026-09-27' },
        // A datetime compares against the local window's instants.
        { fieldId: ends.id, operator: 'gte', value: dayStart('2026-09-27').toISOString() },
      ],
    });
    const byDatetime = calendarWindowFilters(ends, undefined, '2026-09-27', '2026-11-07');
    expect(byDatetime[0]!.clauses[0]).toEqual({
      fieldId: ends.id,
      operator: 'lt',
      value: dayStart('2026-11-08').toISOString(),
    });
  });
});

describe('kanban lanes', () => {
  const users = new Map([
    ['u1', { nickname: 'Jim' }],
    ['u2', { nickname: 'Ann' }],
  ]);

  it('follows the option order, with "no value" last', () => {
    const lanes = kanbanLanes(stage, [], null, users);
    expect(lanes.map((lane) => [lane.key, lane.value])).toEqual([
      ['lead', 'lead'],
      ['won', 'won'],
      ['', null],
    ]);
    // A value that is no longer an option falls into "no value".
    expect(recordLaneKey(fixtureRecord(1, { '2': 'deleted-option' }), stage, lanes)).toBe('');
    expect(recordLaneKey(fixtureRecord(2, { '2': 'won' }), stage, lanes)).toBe('won');
  });

  it('makes one lane per person present in the records or the counts, by name', () => {
    const lanes = kanbanLanes(owner, [fixtureRecord(1, { '3': 'u1' })], new Map([['u2', 4]]), users);
    expect(lanes.map((lane) => lane.label)).toEqual(['Ann', 'Jim', '']);
  });
});

describe('group keys', () => {
  it('match the aggregate’s groups', () => {
    expect(recordGroupKey(fixtureRecord(1, { '2': 'won' }), { fieldId: stage.id }, stage)).toBe('won');
    expect(recordGroupKey(fixtureRecord(1, {}), { fieldId: stage.id }, stage)).toBe('');
    expect(recordGroupKey(fixtureRecord(1, { '6': 10 }), { fieldId: 6 }, fixtureField(6, 'N', 'number'))).toBe('10');
    expect(recordGroupKey(fixtureRecord(1, { '7': false }), { fieldId: 7 }, fixtureField(7, 'B', 'boolean'))).toBe(
      'false',
    );
    expect(recordGroupKey(fixtureRecord(1, {}, { created_by: 'u2' }), { systemField: 'created_by' }, undefined)).toBe(
      'u2',
    );
    const at = dayStart('2026-10-14');
    at.setHours(23, 30);
    expect(
      recordGroupKey(fixtureRecord(1, {}, { created_at: at.toISOString() }), { systemField: 'created_at' }, undefined),
    ).toBe('2026-10-14');
    expect(
      countsByGroup([
        { group: 'won', value: 2 },
        { group: null, value: 1 },
        { group: '', value: 3 },
      ]),
    ).toEqual(
      new Map([
        ['won', 2],
        ['', 4],
      ]),
    );
  });
});
