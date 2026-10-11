/** @vitest-environment happy-dom */

/**
 * The shared card renderers: chart / pivot models (labels, colour slots that
 * follow the entity, folding into "Other", totals), and the interactive cards —
 * KPI and pivot cells drill, a records row opens its record, withheld cards
 * say so, the filter bar emits typed values.
 */

import { act, useState } from 'react';
import { dateRangeBounds } from '@greenhouse/types/table-cards';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableCardSpec } from '@greenhouse/types/tables';
import { I18nProvider, translate } from '../../lib/i18n';
import type { TableField, TableRecord } from '../../lib/api/tables';
import { dimensionLabel, type CardLabelContext } from './card-labels';
import { buildChartModel } from './chart-model';
import { buildPivotModel } from './pivot-card';
import { FilterBar, type DashboardFilterValues } from './filter-bar';
import { TableCardView } from './table-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stamp = '2026-10-11T00:00:00.000Z';
function field(id: number, name: string, type: TableField['type'], config: object = {}): TableField {
  return {
    id,
    table_id: 7,
    name,
    type,
    required: false,
    is_primary: id === 1,
    config: JSON.stringify(config),
    position: id,
    created_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    archived_at: null,
  };
}

const name = field(1, 'Name', 'text');
const stage = field(2, 'Stage', 'single_select', {
  options: [
    { id: 'lead', label: 'Lead' },
    { id: 'open', label: 'Open' },
    { id: 'won', label: 'Won' },
  ],
});
const amount = field(3, 'Amount', 'number');
const signed = field(4, 'Signed', 'datetime');
const rep = field(5, 'Rep', 'user');
const fields = [name, stage, amount, signed, rep];

const usersById = new Map([['u1', { nickname: 'Jim' }]]);
const labels: CardLabelContext = {
  fieldsById: new Map(fields.map((entry) => [entry.id, entry])),
  usersById,
  t: (key, params) => translate('en', key, params),
  locale: 'en-US',
};

const monthly: TableCardSpec = {
  kind: 'chart',
  source: { tableId: 7 },
  aggregate: { operation: 'count', groupBy: { fieldId: 4, dateBucket: 'month' }, series: { fieldId: 2 } },
  chart: { type: 'bar', stacked: true },
};

describe('card models', () => {
  it('labels bucket keys as calendar days, never shifted by the local zone', () => {
    expect(dimensionLabel({ fieldId: 4, dateBucket: 'month' }, '2026-03-01', labels)).toBe('Mar 2026');
    expect(dimensionLabel({ fieldId: 4, dateBucket: 'quarter' }, '2026-10-01', labels)).toBe('2026 Q4');
    expect(dimensionLabel({ systemField: 'created_at' }, '2026-03-01', labels)).toBe('Mar 1, 2026');
    expect(dimensionLabel({ fieldId: 2 }, 'won', labels)).toBe('Won');
    expect(dimensionLabel({ fieldId: 5 }, 'u1', labels)).toBe('Jim');
    expect(dimensionLabel({ fieldId: 2 }, null, labels)).toBe('(Empty)');
    expect(dimensionLabel(undefined, null, labels)).toBe('All records');
  });

  it('builds a stacked chart whose series keep their option colour and map clicks back to points', () => {
    const model = buildChartModel(
      monthly,
      [
        { group: '2026-03-01', series: 'won', value: 2 },
        { group: '2026-03-01', series: 'open', value: 1 },
        { group: '2026-04-01', series: 'won', value: 3 },
      ],
      labels,
    );
    expect(model.data.labels).toEqual(['Mar 2026', 'Apr 2026']);
    // Option order (Lead, Open, Won), not appearance order — "Open" keeps slot 1.
    expect(model.data.datasets.map((dataset) => dataset.label)).toEqual(['Open', 'Won']);
    expect(model.display.colorSlots).toEqual([1, 2]);
    expect(model.data.datasets[0]!.data).toEqual([1, 0]);
    expect(model.points[1]![1]).toEqual({ group: '2026-04-01', series: 'won' });
    expect(model.display.stacked).toBe(true);
  });

  it('folds a ninth slice into Other, which has no drill-down', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ group: `g${index}`, value: 10 - index }));
    const model = buildChartModel(
      {
        kind: 'chart',
        source: { tableId: 7 },
        aggregate: { operation: 'count', groupBy: { fieldId: 1 } },
        chart: { type: 'pie' },
      },
      rows,
      labels,
    );
    expect(model.data.labels).toHaveLength(8);
    expect(model.data.labels.at(-1)).toBe('Other');
    expect(model.data.datasets[0]!.data.at(-1)).toBe(3 + 2 + 1);
    expect(model.points[0]!.at(-1)).toBeNull();
    expect(new Set(model.display.colorSlots).size).toBe(8);
  });

  it('pivots with totals only for additive calculations', () => {
    const rows = [
      { group: 'won', series: 'u1', value: 2 },
      { group: 'open', series: 'u1', value: 1 },
      { group: 'won', series: 'u2', value: 5 },
    ];
    const card: TableCardSpec = {
      kind: 'pivot',
      source: { tableId: 7 },
      aggregate: { operation: 'sum', valueFieldId: 3, groupBy: { fieldId: 2 }, series: { fieldId: 5 } },
    };
    const model = buildPivotModel(card, rows, labels);
    expect(model.rows.map((row) => row.label)).toEqual(['Won', 'Open']);
    expect(model.value('won', 'u2')).toBe(5);
    expect(model.value('open', 'u2')).toBeUndefined();
    expect(model.totals?.grand).toBe(8);
    const average = buildPivotModel({ ...card, aggregate: { ...card.aggregate!, operation: 'avg' } }, rows, labels);
    expect(average.totals).toBeNull();
  });
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(<I18nProvider initialLocale="en">{node}</I18nProvider>);
  });
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (entry) => entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label,
  );
  if (!button) throw new Error(`no button "${label}"`);
  return button as HTMLButtonElement;
}

describe('TableCardView', () => {
  it('shows a KPI with formatKpi and drills into everything it counts', async () => {
    const onDrill = vi.fn();
    await render(
      <TableCardView
        title="Revenue"
        card={{ kind: 'kpi', source: { tableId: 7 }, aggregate: { operation: 'avg', valueFieldId: 3 } }}
        result={{ kind: 'kpi', value: 1234.5678 }}
        fields={fields}
        labels={labels}
        onDrill={onDrill}
      />,
    );
    expect(container.querySelector('[data-testid="table-card-kpi"]')?.textContent).toBe('1,235');
    expect(container.textContent).toContain('Average of Amount');
    await act(async () => buttonByLabel('View records').click());
    expect(onDrill).toHaveBeenCalledWith({ group: null }, 'Revenue');
  });

  it('drills from a pivot cell with its group and series', async () => {
    const onDrill = vi.fn();
    await render(
      <TableCardView
        title="Pipeline"
        card={{
          kind: 'pivot',
          source: { tableId: 7 },
          aggregate: { operation: 'count', groupBy: { fieldId: 2 }, series: { fieldId: 5 } },
        }}
        result={{ kind: 'pivot', rows: [{ group: 'won', series: 'u1', value: 4 }] }}
        fields={fields}
        labels={labels}
        onDrill={onDrill}
      />,
    );
    await act(async () => buttonByLabel('Show records for Won · Jim').click());
    expect(onDrill).toHaveBeenCalledWith({ group: 'won', series: 'u1' }, 'Won · Jim');
  });

  it('opens a record from a records card row', async () => {
    const onOpenRecord = vi.fn();
    const record: TableRecord = {
      id: 42,
      table_id: 7,
      values: { '1': 'Acme', '2': 'won' },
      computed_values: {},
      revision: 1,
      created_by: 'u1',
      updated_by: 'u1',
      created_at: stamp,
      updated_at: stamp,
      deleted_at: null,
    };
    await render(
      <TableCardView
        title="Latest"
        card={{ kind: 'records', source: { tableId: 7 }, fieldIds: [1, 2], systemFields: ['created_by'] }}
        result={{ kind: 'records', page: { records: [record], total: 1, nextCursor: null } }}
        fields={fields}
        labels={labels}
        onOpenRecord={onOpenRecord}
      />,
    );
    expect([...container.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual([
      'Name',
      'Stage',
      'Created by',
    ]);
    expect(container.textContent).toContain('Jim');
    await act(async () => (container.querySelector('tbody tr') as HTMLTableRowElement).click());
    expect(onOpenRecord).toHaveBeenCalledWith(record);
  });

  it('says a withheld card is not available instead of drawing it', async () => {
    await render(
      <TableCardView title="Secret" card={null} result={{ kind: 'no_access' }} fields={[]} labels={labels} />,
    );
    expect(container.textContent).toContain('Not available to you');
  });

  it('offers chart points as buttons for keyboard users', async () => {
    const onDrill = vi.fn();
    await render(
      <TableCardView
        title="Monthly"
        card={monthly}
        result={{ kind: 'chart', rows: [{ group: '2026-03-01', series: 'won', value: 2 }] }}
        fields={fields}
        labels={labels}
        onDrill={onDrill}
      />,
    );
    await act(async () => buttonByLabel('Show records for Mar 2026 · Won').click());
    expect(onDrill).toHaveBeenCalledWith({ group: '2026-03-01', series: 'won' }, 'Mar 2026 · Won');
  });
});

describe('FilterBar', () => {
  function change(select: HTMLSelectElement, value: string) {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('emits typed values per control kind', async () => {
    const onChange = vi.fn();
    await render(
      <FilterBar
        controls={[
          { id: 'period', label: 'Period', kind: 'date_range', targets: [{ tableId: 7, fieldId: 4 }] },
          { id: 'stage', label: 'Stage', kind: 'select', targets: [{ tableId: 7, fieldId: 2 }] },
          { id: 'rep', label: 'Rep', kind: 'user', targets: [{ tableId: 7, fieldId: 5 }] },
        ]}
        values={{}}
        onChange={onChange}
        fieldsByTable={new Map([[7, fields]])}
        users={[{ id: 'u1', nickname: 'Jim', email: 'jim@example.com' }]}
      />,
    );
    const select = (label: string) => container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
    expect([...select('Stage').options].map((option) => option.textContent)).toEqual(['All', 'Lead', 'Open', 'Won']);
    await act(async () => change(select('Period'), 'this_month'));
    expect(onChange).toHaveBeenLastCalledWith({ period: { kind: 'date_range', preset: 'this_month' } });
    await act(async () => change(select('Stage'), 'won'));
    expect(onChange).toHaveBeenLastCalledWith({ stage: { kind: 'select', values: ['won'] } });
    await act(async () => change(select('Rep'), '$me'));
    expect(onChange).toHaveBeenLastCalledWith({ rep: { kind: 'user', userIds: ['$me'] } });
  });

  it('opens Custom from an active preset, starting at the preset’s days', async () => {
    const onChange = vi.fn();
    const control = {
      id: 'period',
      label: 'Period',
      kind: 'date_range' as const,
      targets: [{ tableId: 7, systemField: 'created_at' as const }],
      defaultValue: { kind: 'date_range' as const, preset: 'this_month' as const },
    };
    function Stateful() {
      const [values, setValues] = useState<DashboardFilterValues>({});
      return (
        <FilterBar
          controls={[control]}
          values={values}
          onChange={(next) => {
            onChange(next);
            setValues(next);
          }}
          fieldsByTable={new Map()}
          users={[]}
        />
      );
    }
    await render(<Stateful />);
    const select = container.querySelector('select[aria-label="Period"]') as HTMLSelectElement;
    expect(select.value).toBe('this_month');
    await act(async () => change(select, 'custom'));
    const bounds = dateRangeBounds(control.defaultValue, Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(onChange).toHaveBeenLastCalledWith({ period: { kind: 'date_range', ...bounds } });
    expect(select.value).toBe('custom');
    expect(container.querySelectorAll('input[type="date"]')).toHaveLength(2);
  });

  it('shows a control default and lets the viewer reset to defaults', async () => {
    const onChange = vi.fn();
    await render(
      <FilterBar
        controls={[
          {
            id: 'period',
            label: 'Period',
            kind: 'date_range',
            targets: [{ tableId: 7, systemField: 'created_at' }],
            defaultValue: { kind: 'date_range', preset: 'last_7_days' },
          },
        ]}
        values={{ period: null }}
        onChange={onChange}
        fieldsByTable={new Map()}
        users={[]}
      />,
    );
    expect((container.querySelector('select[aria-label="Period"]') as HTMLSelectElement).value).toBe('');
    await act(async () => buttonByLabel('Reset filters').click());
    expect(onChange).toHaveBeenCalledWith({});
  });
});
