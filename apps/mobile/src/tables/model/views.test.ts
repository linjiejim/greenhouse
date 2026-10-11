/**
 * The phone's view rules (./views.ts): the query each view type asks, the
 * session overrides, kanban lanes and the calendar window / agenda.
 */

import { describe, expect, it } from 'vitest';

import type { FieldLike } from './fields';
import {
  busyDays,
  calendarWindowFilters,
  completeClause,
  groupRecords,
  laneValue,
  monthBounds,
  NO_VALUE_GROUP,
  onDay,
  viewConfig,
  viewQuery,
  visibleFieldIds,
} from './views';

const status: FieldLike = {
  id: 2,
  name: 'Status',
  type: 'single_select',
  config: {
    options: [
      { id: 'open', label: 'Open' },
      { id: 'done', label: 'Done', color: '#10B981' },
    ],
  },
};
const owner: FieldLike = { id: 4, name: 'Owner', type: 'user', config: '{}' };
const start: FieldLike = { id: 6, name: 'Start', type: 'date', config: '{}' };
const end: FieldLike = { id: 7, name: 'End', type: 'date', config: '{}' };

const rec = (id: number, values: Record<string, unknown>) => ({ id, values });

describe('view query', () => {
  it('keeps the view query and ANDs the phone’s overrides on top', () => {
    const config = viewConfig({
      config: JSON.stringify({
        query: {
          where: { combinator: 'and', clauses: [{ fieldId: 2, operator: 'eq', value: 'open' }] },
          sort: [{ fieldId: 5, direction: 'asc' }],
        },
        groupBy: { fieldId: 2 },
      }),
    });
    expect(viewQuery('grid', config)).toEqual({
      where: { combinator: 'and', clauses: [{ fieldId: 2, operator: 'eq', value: 'open' }] },
      sort: [{ fieldId: 5, direction: 'asc' }],
      groupBy: { fieldId: 2 },
    });
    const overridden = viewQuery('grid', config, {
      overrides: {
        sort: [{ systemField: 'created_at', direction: 'desc' }],
        clauses: [{ fieldId: 4, operator: 'eq', value: '$me' }],
        groupFieldId: null,
      },
      search: ' laptops ',
    });
    expect(overridden).toEqual({
      where: { combinator: 'and', clauses: [{ fieldId: 2, operator: 'eq', value: 'open' }] },
      filters: [{ combinator: 'and', clauses: [{ fieldId: 4, operator: 'eq', value: '$me' }] }],
      sort: [{ systemField: 'created_at', direction: 'desc' }],
      search: 'laptops',
    });
  });

  it('shows the chosen fields in order, dropping unknown ones', () => {
    const fields = [status, owner, start];
    expect(visibleFieldIds({}, fields)).toEqual([2, 4, 6]);
    expect(visibleFieldIds({ fieldIds: [6, 99, 2] }, fields)).toEqual([6, 2]);
    expect(visibleFieldIds({ fieldIds: [6] }, fields, { fieldIds: [4] })).toEqual([4]);
  });

  it('sends a clause only once it has what it needs', () => {
    expect(completeClause({ fieldId: 2, operator: 'eq', value: '' })).toBeNull();
    expect(completeClause({ fieldId: 2, operator: 'is_empty', value: 'x' })).toEqual({
      fieldId: 2,
      operator: 'is_empty',
      value: undefined,
    });
  });
});

describe('kanban lanes', () => {
  it('one lane per option in option order, people by first appearance, then "no value"', () => {
    const records = [rec(1, { '2': 'done' }), rec(2, { '2': 'open' }), rec(3, {}), rec(4, { '2': 'gone' })];
    const lanes = groupRecords(status, records, { userLabel: (id) => id, noValue: 'No value' });
    expect(lanes.map((lane) => [lane.key, lane.records.map((r) => r.id)])).toEqual([
      ['open', [2]],
      ['done', [1]],
      [NO_VALUE_GROUP, [3, 4]],
    ]);
    expect(lanes[1]!.color).toBe('#10B981');
    const people = groupRecords(owner, [rec(1, { '4': 'u2' }), rec(2, { '4': 'u1' })], {
      userLabel: (id) => ({ u1: 'Ada', u2: 'Lin' })[id] ?? id,
      noValue: 'Nobody',
      hidden: [NO_VALUE_GROUP],
    });
    expect(people.map((lane) => lane.label)).toEqual(['Lin', 'Ada']);
    expect(laneValue(NO_VALUE_GROUP)).toBeNull();
    expect(laneValue('open')).toBe('open');
  });
});

describe('calendar', () => {
  it('asks for records overlapping the month', () => {
    expect(monthBounds('2026-02-14')).toEqual({ first: '2026-02-01', last: '2026-02-28' });
    expect(calendarWindowFilters(start, end, '2026-02-01', '2026-02-28')).toEqual([
      { combinator: 'and', clauses: [{ fieldId: 6, operator: 'lte', value: '2026-02-28' }] },
      {
        combinator: 'or',
        clauses: [
          { fieldId: 6, operator: 'gte', value: '2026-02-01' },
          { fieldId: 7, operator: 'gte', value: '2026-02-01' },
        ],
      },
    ]);
  });

  it('places a record on every day it spans, and marks the busy days', () => {
    const trip = rec(1, { '6': '2026-01-30', '7': '2026-02-02' });
    expect(onDay(trip, start, end, '2026-02-01')).toBe(true);
    expect(onDay(trip, start, end, '2026-02-03')).toBe(false);
    expect(onDay(trip, start, undefined, '2026-01-30')).toBe(true);
    expect([...busyDays([trip], start, end, '2026-02-01', '2026-02-28')]).toEqual(['2026-02-01', '2026-02-02']);
  });
});
