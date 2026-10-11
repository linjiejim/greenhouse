/**
 * The card helpers every card consumer shares: legacy widget mapping, the card
 * shape, filter-control values → predicates (presets in a time zone), drill-down
 * predicates (date buckets and series), group merging and reader trimming.
 */

import { describe, expect, it } from 'vitest';
import {
  bucketRange,
  cardQueryFieldIds,
  dateRangeBounds,
  drilldownFilters,
  filterGroupsForTable,
  filterValueToGroups,
  legacyWidgetToCard,
  mergeFilterGroups,
  normalizeDashboardConfig,
  normalizeFilterControl,
  normalizeFilterValue,
  normalizeTableCardSpec,
  trimCardForReader,
  trimFilterControlsForReader,
  widgetTypeForCard,
} from '../table-cards.js';
import type { TableCardSpec, TableFieldType, TableFilterControl } from '../tables.js';

describe('legacyWidgetToCard', () => {
  it('maps every legacy flat widget type onto a card', () => {
    expect(legacyWidgetToCard('text', { text: '# Hi' }, null)).toEqual({ kind: 'text', markdown: '# Hi' });
    expect(legacyWidgetToCard('kpi', { operation: 'sum', valueFieldId: 4 }, 7)).toEqual({
      kind: 'kpi',
      source: { tableId: 7 },
      aggregate: { operation: 'sum', valueFieldId: 4 },
    });
    expect(legacyWidgetToCard('bar', { operation: 'count', groupByFieldId: 3, limit: 30 }, 7)).toEqual({
      kind: 'chart',
      source: { tableId: 7 },
      aggregate: { operation: 'count', groupBy: { fieldId: 3 }, limit: 30 },
      chart: { type: 'bar' },
    });
    expect(legacyWidgetToCard('pie', {}, 7)).toMatchObject({ kind: 'chart', chart: { type: 'pie' } });
    const where = { combinator: 'and' as const, clauses: [{ fieldId: 3, operator: 'eq' as const, value: 'x' }] };
    expect(legacyWidgetToCard('records', { query: { where }, limit: 20 }, 7)).toEqual({
      kind: 'records',
      source: { tableId: 7, query: { where } },
      limit: 20,
    });
    // count ignores a stray value field
    expect(legacyWidgetToCard('kpi', { operation: 'count', valueFieldId: 4 }, 7).aggregate).toEqual({
      operation: 'count',
    });
  });

  it('prefers the stored card and tolerates a widget without a table', () => {
    const card: TableCardSpec = { kind: 'text', markdown: 'kept' };
    expect(legacyWidgetToCard('bar', { card }, 7)).toBe(card);
    expect(legacyWidgetToCard('kpi', null, null)).toEqual({ kind: 'kpi', aggregate: { operation: 'count' } });
  });

  it('keeps the stored type consistent with the card', () => {
    expect(widgetTypeForCard({ kind: 'chart', chart: { type: 'area' } })).toBe('area');
    expect(widgetTypeForCard({ kind: 'chart' })).toBe('bar');
    expect(widgetTypeForCard({ kind: 'pivot' })).toBe('pivot');
    expect(widgetTypeForCard({ kind: 'records' })).toBe('records');
  });
});

describe('normalizeTableCardSpec', () => {
  it('accepts a stacked monthly chart and drops flags that mean nothing for the type', () => {
    const result = normalizeTableCardSpec({
      kind: 'chart',
      source: { tableId: 1, query: { search: 'x', cursor: 'c', limit: 9 } },
      aggregate: {
        operation: 'sum',
        valueFieldId: 2,
        groupBy: { systemField: 'created_at', dateBucket: 'month' },
        series: { fieldId: 3 },
        sort: 'group_asc',
      },
      chart: { type: 'bar', stacked: true, horizontal: true, donut: true, extra: 1 },
      junk: true,
    });
    expect(result).toEqual({
      ok: true,
      card: {
        kind: 'chart',
        source: { tableId: 1, query: { search: 'x' } },
        aggregate: {
          operation: 'sum',
          valueFieldId: 2,
          groupBy: { systemField: 'created_at', dateBucket: 'month' },
          series: { fieldId: 3 },
          sort: 'group_asc',
        },
        chart: { type: 'bar', stacked: true, horizontal: true },
      },
    });
  });

  it('rejects malformed cards with a message', () => {
    const bad = (card: unknown) => {
      const result = normalizeTableCardSpec(card);
      return result.ok ? null : result.error;
    };
    expect(bad({ kind: 'gauge' })).toMatch(/Unsupported card kind/);
    expect(bad({ kind: 'kpi' })).toMatch(/source.tableId/);
    expect(bad({ kind: 'kpi', source: { tableId: 1 }, aggregate: { operation: 'sum' } })).toMatch(/valueFieldId/);
    expect(bad({ kind: 'pivot', source: { tableId: 1 }, aggregate: { operation: 'count' } })).toMatch(/groupBy/);
    expect(
      bad({ kind: 'chart', source: { tableId: 1 }, aggregate: { operation: 'count', series: { fieldId: 2 } } }),
    ).toMatch(/series requires/);
    expect(
      bad({
        kind: 'chart',
        source: { tableId: 1 },
        chart: { type: 'pie' },
        aggregate: { operation: 'count', groupBy: { fieldId: 1 }, series: { fieldId: 2 } },
      }),
    ).toMatch(/second dimension/);
    expect(
      bad({
        kind: 'chart',
        source: { tableId: 1 },
        aggregate: { operation: 'count', groupBy: { systemField: 'created_by', dateBucket: 'day' } },
      }),
    ).toMatch(/dateBucket/);
    expect(bad({ kind: 'records', source: { tableId: 1 }, limit: 500 })).toMatch(/limit/);
    expect(bad({ kind: 'text', markdown: 'x'.repeat(100_001) })).toMatch(/exceeds/);
  });
});

describe('filter controls', () => {
  it('validates control shapes and the one-date-target-per-table rule', () => {
    expect(
      normalizeFilterControl({
        id: 'period',
        label: ' Period ',
        kind: 'date_range',
        targets: [{ tableId: 1, systemField: 'created_at' }],
        defaultValue: { kind: 'date_range', preset: 'this_month' },
      }),
    ).toEqual({
      ok: true,
      control: {
        id: 'period',
        label: 'Period',
        kind: 'date_range',
        targets: [{ tableId: 1, systemField: 'created_at' }],
        defaultValue: { kind: 'date_range', preset: 'this_month' },
      },
    });
    const error = (raw: unknown) => {
      const result = normalizeFilterControl(raw);
      return result.ok ? null : result.error;
    };
    expect(
      error({
        id: 'd',
        label: 'D',
        kind: 'date_range',
        targets: [
          { tableId: 1, fieldId: 2 },
          { tableId: 1, fieldId: 3 },
        ],
      }),
    ).toMatch(/one field per table/);
    expect(error({ id: 'u', label: 'U', kind: 'user', targets: [{ tableId: 1, systemField: 'created_at' }] })).toMatch(
      /cannot filter/,
    );
    expect(error({ id: 'bad id!', label: 'x', kind: 'search', targets: [{ tableId: 1, fieldId: 2 }] })).toMatch(/id/);
    const config = normalizeDashboardConfig({
      filters: [
        { id: 'a', label: 'A', kind: 'search', targets: [{ tableId: 1, fieldId: 2 }] },
        { id: 'a', label: 'B', kind: 'search', targets: [{ tableId: 1, fieldId: 2 }] },
      ],
    });
    expect(config).toEqual({ ok: false, error: 'Duplicate filter id "a"' });
    expect(normalizeDashboardConfig(undefined)).toEqual({ ok: true, config: { version: 1, filters: [] } });
  });

  it('cleans viewer values and ignores ones for another kind', () => {
    expect(normalizeFilterValue('select', { kind: 'select', values: ['a', 'a', ' ', 3, 'b'] })).toEqual({
      kind: 'select',
      values: ['a', 'b'],
    });
    expect(normalizeFilterValue('select', { kind: 'user', userIds: ['x'] })).toBeNull();
    expect(normalizeFilterValue('search', { kind: 'search', text: '   ' })).toBeNull();
    expect(normalizeFilterValue('date_range', { kind: 'date_range', from: '2026-03-31', to: '2026-03-01' })).toEqual({
      kind: 'date_range',
      from: '2026-03-01',
      to: '2026-03-31',
    });
    expect(normalizeFilterValue('date_range', { kind: 'date_range', from: '2026-02-30' })).toBeNull();
  });

  it('resolves presets to calendar days in the viewer zone', () => {
    // 2026-10-11 18:30 UTC is already Monday 2026-10-12 in Shanghai.
    const now = new Date('2026-10-11T18:30:00.000Z');
    const preset = (name: Parameters<typeof dateRangeBounds>[0]['preset'], zone = 'Asia/Shanghai') =>
      dateRangeBounds({ kind: 'date_range', preset: name }, zone, now);
    expect(preset('today')).toEqual({ from: '2026-10-12', to: '2026-10-12' });
    expect(preset('today', 'UTC')).toEqual({ from: '2026-10-11', to: '2026-10-11' });
    expect(preset('last_7_days')).toEqual({ from: '2026-10-06', to: '2026-10-12' });
    expect(preset('last_30_days')).toEqual({ from: '2026-09-13', to: '2026-10-12' });
    expect(preset('this_week')).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(preset('this_week', 'UTC')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(preset('this_month')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(preset('this_quarter')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(preset('this_year')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(dateRangeBounds({ kind: 'date_range', to: '2026-01-05' }, 'UTC', now)).toEqual({ to: '2026-01-05' });
  });

  const fieldTypes: Record<number, TableFieldType> = { 10: 'single_select', 11: 'multi_select', 12: 'multi_user' };
  const fieldType = ({ fieldId }: { fieldId: number }) => fieldTypes[fieldId];

  it('turns each kind into the predicates of the tables it targets', () => {
    const now = new Date('2026-03-15T12:00:00.000Z');
    const range: TableFilterControl = {
      id: 'period',
      label: 'Period',
      kind: 'date_range',
      targets: [
        { tableId: 1, systemField: 'created_at' },
        { tableId: 2, fieldId: 20 },
      ],
    };
    expect(filterValueToGroups(range, { kind: 'date_range', preset: 'this_month' }, 'UTC', { now })).toEqual([
      {
        tableId: 1,
        group: {
          combinator: 'and',
          clauses: [
            { systemField: 'created_at', operator: 'gte', value: '2026-03-01' },
            { systemField: 'created_at', operator: 'lte', value: '2026-03-31' },
          ],
        },
      },
      {
        tableId: 2,
        group: {
          combinator: 'and',
          clauses: [
            { fieldId: 20, operator: 'gte', value: '2026-03-01' },
            { fieldId: 20, operator: 'lte', value: '2026-03-31' },
          ],
        },
      },
    ]);

    const status: TableFilterControl = {
      id: 'status',
      label: 'Status',
      kind: 'select',
      targets: [
        { tableId: 1, fieldId: 10 },
        { tableId: 1, fieldId: 11 },
      ],
    };
    expect(filterValueToGroups(status, { kind: 'select', values: ['a', 'b'] }, 'UTC', { fieldType })).toEqual([
      {
        tableId: 1,
        group: {
          combinator: 'or',
          clauses: [
            { fieldId: 10, operator: 'in', value: ['a', 'b'] },
            { fieldId: 11, operator: 'contains', value: 'a' },
            { fieldId: 11, operator: 'contains', value: 'b' },
          ],
        },
      },
    ]);

    const owner: TableFilterControl = {
      id: 'owner',
      label: 'Owner',
      kind: 'user',
      targets: [
        { tableId: 1, systemField: 'created_by' },
        { tableId: 1, fieldId: 12 },
      ],
    };
    expect(filterValueToGroups(owner, { kind: 'user', userIds: ['$me'] }, 'UTC', { fieldType })[0]!.group).toEqual({
      combinator: 'or',
      clauses: [
        { systemField: 'created_by', operator: 'in', value: ['$me'] },
        { fieldId: 12, operator: 'contains', value: '$me' },
      ],
    });

    const search: TableFilterControl = { id: 'q', label: 'Q', kind: 'search', targets: [{ tableId: 3, fieldId: 30 }] };
    expect(filterValueToGroups(search, { kind: 'search', text: ' acme ' }, 'UTC')).toEqual([
      { tableId: 3, group: { combinator: 'or', clauses: [{ fieldId: 30, operator: 'contains', value: 'acme' }] } },
    ]);
    expect(filterValueToGroups(search, null, 'UTC')).toEqual([]);
  });

  it('uses defaults unless the viewer chose (or cleared) a value', () => {
    const control: TableFilterControl = {
      id: 'q',
      label: 'Q',
      kind: 'search',
      targets: [{ tableId: 1, fieldId: 5 }],
      defaultValue: { kind: 'search', text: 'default' },
    };
    const clauses = (values?: Record<string, unknown>) =>
      filterGroupsForTable([control], values, 1, 'UTC').flatMap((group) => group.clauses);
    expect(clauses()).toEqual([{ fieldId: 5, operator: 'contains', value: 'default' }]);
    expect(clauses({ q: { kind: 'search', text: 'mine' } })).toEqual([
      { fieldId: 5, operator: 'contains', value: 'mine' },
    ]);
    expect(clauses({ q: null })).toEqual([]);
    expect(filterGroupsForTable([control], undefined, 2, 'UTC')).toEqual([]);
  });

  it('drops targets a restricted reader cannot read, and controls left empty', () => {
    const controls: TableFilterControl[] = [
      {
        id: 'amount',
        label: 'Amount',
        kind: 'search',
        targets: [
          { tableId: 1, fieldId: 7 },
          { tableId: 2, fieldId: 8 },
        ],
      },
      { id: 'hidden', label: 'Hidden', kind: 'search', targets: [{ tableId: 1, fieldId: 9 }] },
      { id: 'mine', label: 'Mine', kind: 'user', targets: [{ tableId: 1, systemField: 'created_by' }] },
      { id: 'other', label: 'Other', kind: 'user', targets: [{ tableId: 3, systemField: 'created_by' }] },
    ];
    const readable = new Map<number, ReadonlySet<number> | null>([
      [1, new Set([7])],
      [2, null],
    ]);
    const trimmed = trimFilterControlsForReader(controls, (tableId) => readable.get(tableId));
    expect(trimmed.map((control) => control.id)).toEqual(['amount', 'mine']);
    expect(trimmed[0]!.targets).toHaveLength(2);
    const narrower = trimFilterControlsForReader(controls, (tableId) => (tableId === 1 ? new Set([7]) : undefined));
    expect(narrower[0]!.targets).toEqual([{ tableId: 1, fieldId: 7 }]);
  });
});

describe('drill-down', () => {
  it('computes inclusive bucket ranges', () => {
    expect(bucketRange('day', '2026-02-28')).toEqual({ from: '2026-02-28', to: '2026-02-28' });
    expect(bucketRange('week', '2026-12-28')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
    expect(bucketRange('month', '2028-02-01')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(bucketRange('quarter', '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(bucketRange('year', '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  const monthly: TableCardSpec = {
    kind: 'chart',
    source: { tableId: 1 },
    aggregate: {
      operation: 'count',
      groupBy: { fieldId: 4, dateBucket: 'month' },
      series: { fieldId: 5 },
    },
    chart: { type: 'bar', stacked: true },
  };

  it('selects a date bucket and a series value', () => {
    expect(drilldownFilters(monthly, { group: '2026-03-01', series: 'open' })).toEqual({
      combinator: 'and',
      clauses: [
        { fieldId: 4, operator: 'gte', value: '2026-03-01' },
        { fieldId: 4, operator: 'lte', value: '2026-03-31' },
        { fieldId: 5, operator: 'eq', value: 'open' },
      ],
    });
    expect(drilldownFilters(monthly, { group: null, series: null }).clauses).toEqual([
      { fieldId: 4, operator: 'is_empty' },
      { fieldId: 5, operator: 'is_empty' },
    ]);
  });

  it('defaults system time groups to days and restores typed keys', () => {
    const byDay: TableCardSpec = {
      kind: 'pivot',
      source: { tableId: 1 },
      aggregate: { operation: 'count', groupBy: { systemField: 'created_at' }, series: { systemField: 'created_by' } },
    };
    expect(drilldownFilters(byDay, { group: '2026-03-10', series: 'u1' }).clauses).toEqual([
      { systemField: 'created_at', operator: 'gte', value: '2026-03-10' },
      { systemField: 'created_at', operator: 'lte', value: '2026-03-10' },
      { systemField: 'created_by', operator: 'eq', value: 'u1' },
    ]);
    const types: Record<number, TableFieldType> = { 1: 'number', 2: 'boolean', 3: 'multi_select' };
    const typed = (fieldId: number, group: string) =>
      drilldownFilters(
        { kind: 'chart', source: { tableId: 1 }, aggregate: { operation: 'count', groupBy: { fieldId } } },
        { group },
        ({ fieldId: id }) => types[id],
      ).clauses[0]!.value;
    expect(typed(1, '12.5')).toBe(12.5);
    expect(typed(2, 'false')).toBe(false);
    expect(typed(3, '["a", "b"]')).toEqual(['a', 'b']);
    // A KPI (no grouping) drills into everything the card counts.
    expect(drilldownFilters({ kind: 'kpi', source: { tableId: 1 } }, { group: null }).clauses).toEqual([]);
  });
});

describe('mergeFilterGroups and reader trimming', () => {
  it('folds AND and single-clause groups together, keeping real OR groups', () => {
    const or = {
      combinator: 'or' as const,
      clauses: [
        { fieldId: 1, operator: 'eq' as const, value: 'a' },
        { fieldId: 2, operator: 'eq' as const, value: 'a' },
      ],
    };
    const merged = mergeFilterGroups([
      { combinator: 'and', clauses: [{ fieldId: 3, operator: 'gte', value: 1 }] },
      or,
      { combinator: 'or', clauses: [{ fieldId: 4, operator: 'eq', value: 'x' }] },
      { combinator: 'and', clauses: [] },
    ]);
    expect(merged).toEqual([
      {
        combinator: 'and',
        clauses: [
          { fieldId: 3, operator: 'gte', value: 1 },
          { fieldId: 4, operator: 'eq', value: 'x' },
        ],
      },
      or,
    ]);
    const many = Array.from({ length: 25 }, (_, index) => ({
      combinator: 'and' as const,
      clauses: [{ fieldId: index + 1, operator: 'is_empty' as const }],
    }));
    expect(mergeFilterGroups(many).map((group) => group.clauses.length)).toEqual([20, 5]);
  });

  it('withholds a card whose predicate touches a hidden field and drops hidden columns', () => {
    const card: TableCardSpec = {
      kind: 'records',
      source: {
        tableId: 1,
        query: {
          where: { combinator: 'and', clauses: [{ fieldId: 2, operator: 'gt', value: 100 }] },
          sort: [{ fieldId: 3, direction: 'desc' }],
        },
      },
      fieldIds: [1, 2, 4],
    };
    expect(cardQueryFieldIds(card).sort()).toEqual([2, 3]);
    expect(trimCardForReader(card, new Set([1, 3, 4]))).toBeNull();
    expect(trimCardForReader(card, new Set([1, 2, 3]))).toEqual({ ...card, fieldIds: [1, 2] });
    expect(trimCardForReader(card, null)).toBe(card);
    expect(trimCardForReader(card, undefined)).toBeNull();
    expect(trimCardForReader({ kind: 'text', markdown: 'x' }, undefined)).toEqual({ kind: 'text', markdown: 'x' });
  });
});
