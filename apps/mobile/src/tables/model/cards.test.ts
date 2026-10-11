/**
 * Aggregate cards on the phone (./cards.ts) read the aggregate the way the web
 * does: labels, the chart's datasets and "Other" fold, pivot totals.
 */

import { describe, expect, it } from 'vitest';

import type { TableCardSpec } from '../../shared/tables';
import { buildChartModel, buildPivotModel, dimensionLabel, type CardLabelContext } from './cards';
import type { FieldLike } from './fields';

const dept: FieldLike = {
  id: 3,
  name: 'Dept',
  type: 'single_select',
  config: {
    options: [
      { id: 'it', label: 'IT' },
      { id: 'hr', label: 'HR' },
    ],
  },
};
const amount: FieldLike = { id: 5, name: 'Amount', type: 'number', config: '{}' };

const ctx: CardLabelContext = {
  fieldsById: new Map([
    [3, dept],
    [5, amount],
  ]),
  userLabel: (id) => ({ u1: 'Ada' })[id],
  copy: {
    allRecords: 'All records',
    empty: '(empty)',
    other: 'Other',
    total: 'Total',
    yes: 'Yes',
    no: 'No',
    weekOf: (date) => `Week of ${date}`,
    quarter: (year, quarter) => `Q${quarter} ${year}`,
    valueCaption: (operation, field) => (operation === 'count' ? 'Records' : `${operation} of ${field}`),
    systemField: (field) => field,
  },
  locale: 'en-US',
};

describe('card labels', () => {
  it('reads options, buckets, people and empties', () => {
    expect(dimensionLabel({ fieldId: 3 }, 'hr', ctx)).toBe('HR');
    expect(dimensionLabel({ fieldId: 3 }, null, ctx)).toBe('(empty)');
    expect(dimensionLabel({ systemField: 'created_at', dateBucket: 'month' }, '2026-03-01', ctx)).toBe('Mar 2026');
    expect(dimensionLabel({ systemField: 'created_at', dateBucket: 'quarter' }, '2026-04-01', ctx)).toBe('Q2 2026');
    expect(dimensionLabel({ systemField: 'created_by' }, 'u1', ctx)).toBe('Ada');
    expect(dimensionLabel(undefined, null, ctx)).toBe('All records');
  });
});

describe('chart model', () => {
  const monthly: TableCardSpec = {
    kind: 'chart',
    source: { tableId: 1 },
    aggregate: { operation: 'sum', valueFieldId: 5, groupBy: { systemField: 'created_at', dateBucket: 'month' } },
    chart: { type: 'area' },
  };

  it('one dataset over the groups, captioned by the measure; area draws as a line with a hint', () => {
    const model = buildChartModel(
      monthly,
      [
        { group: '2026-01-01', value: 10 },
        { group: '2026-02-01', value: 30 },
      ],
      ctx,
    );
    expect(model.data).toEqual({
      type: 'line',
      labels: ['Jan 2026', 'Feb 2026'],
      datasets: [{ label: 'sum of Amount', data: [10, 30] }],
    });
    expect(model.hints.area).toBe(true);
  });

  it('one dataset per series in option order, missing cells as 0', () => {
    const card: TableCardSpec = {
      ...monthly,
      chart: { type: 'bar', stacked: true },
      aggregate: { ...monthly.aggregate!, series: { fieldId: 3 } },
    };
    const model = buildChartModel(
      card,
      [
        { group: '2026-01-01', series: 'hr', value: 2 },
        { group: '2026-01-01', series: 'it', value: 5 },
        { group: '2026-02-01', series: 'it', value: 7 },
      ],
      ctx,
    );
    expect(model.data.datasets).toEqual([
      { label: 'IT', data: [5, 7] },
      { label: 'HR', data: [2, 0] },
    ]);
    expect(model.hints.stacked).toBe(true);
  });

  it('folds a pie past eight slices into "Other"', () => {
    const pie: TableCardSpec = {
      kind: 'chart',
      source: { tableId: 1 },
      aggregate: { operation: 'count', groupBy: { fieldId: 5 } },
      chart: { type: 'pie', donut: true },
    };
    const rows = Array.from({ length: 10 }, (_, index) => ({ group: index, value: 10 - index }));
    const model = buildChartModel(pie, rows, ctx);
    expect(model.data.type).toBe('doughnut');
    expect(model.data.labels).toHaveLength(8);
    expect(model.data.labels.at(-1)).toBe('Other');
    expect(model.data.datasets[0]!.data.at(-1)).toBe(2 + 1 + 3);
  });
});

describe('pivot model', () => {
  it('rows × columns with totals for count / sum', () => {
    const card: TableCardSpec = {
      kind: 'pivot',
      source: { tableId: 1 },
      aggregate: { operation: 'count', groupBy: { fieldId: 3 }, series: { systemField: 'created_by' } },
    };
    const model = buildPivotModel(
      card,
      [
        { group: 'it', series: 'u1', value: 2 },
        { group: 'hr', series: 'u1', value: 1 },
      ],
      ctx,
    );
    expect(model.rows.map((row) => row.label)).toEqual(['IT', 'HR']);
    expect(model.columns.map((column) => column.label)).toEqual(['Ada']);
    expect(model.value('it', 'u1')).toBe(2);
    expect(model.totals?.grand).toBe(3);
    const averages = buildPivotModel(
      { ...card, aggregate: { ...card.aggregate!, operation: 'avg', valueFieldId: 5 } },
      [],
      ctx,
    );
    expect(averages.totals).toBeNull();
  });
});
