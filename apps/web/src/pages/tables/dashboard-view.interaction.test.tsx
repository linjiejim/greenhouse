/** @vitest-environment happy-dom */

/**
 * The dashboard page under interaction: widgets are evaluated with the viewer's
 * time zone and filter values; changing a filter re-evaluates them; a pivot
 * cell opens the drill-down drawer with the records behind it (same filters,
 * the cell's point); a drilled record opens in its table; a records-changed
 * event refreshes only the widgets reading that table.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import type {
  TableDashboard,
  TableDashboardWidget,
  TableDefinition,
  TableField,
  TableRecord,
} from '../../lib/api/tables';
import { TablesDashboardView } from './dashboard-view';

const api = vi.hoisted(() => ({
  getTableDashboard: vi.fn(),
  getTableSchema: vi.fn(),
  queryTableDashboardWidget: vi.fn(),
  listTableUsers: vi.fn(),
  updateTableDashboardWidget: vi.fn(),
  deleteTableDashboardWidget: vi.fn(),
}));
vi.mock('../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/tables')>()),
  ...api,
}));

const realtime = vi.hoisted(() => ({ onChange: null as null | ((events: Array<{ tableId: number }>) => void) }));
vi.mock('../../hooks/use-tables-records-changed', () => ({
  useTablesRecordsChanged: (_filter: unknown, onChange: (events: Array<{ tableId: number }>) => void) => {
    realtime.onChange = onChange;
  },
}));

// The grid measures its container; render cells directly instead.
vi.mock('../../components/workbench/widget-grid', () => ({
  WIDGET_DRAG_HANDLE_CLASS: 'widget-drag-handle',
  WidgetGrid: ({
    items,
    renderItem,
  }: {
    items: Array<{ id: string }>;
    renderItem: (id: string) => React.ReactNode;
  }) => (
    <div>
      {items.map((item) => (
        <div key={item.id}>{renderItem(item.id)}</div>
      ))}
    </div>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stamp = '2026-10-11T00:00:00.000Z';
const table: TableDefinition = {
  id: 7,
  base_id: 3,
  name: 'Deals',
  description: null,
  position: 0,
  schema_revision: 1,
  created_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
  archived_at: null,
};

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

const fields = [
  field(1, 'Name', 'text'),
  field(2, 'Stage', 'single_select', {
    options: [
      { id: 'open', label: 'Open' },
      { id: 'won', label: 'Won' },
    ],
  }),
  field(5, 'Rep', 'user'),
];

const dashboard: TableDashboard = {
  id: 11,
  base_id: 3,
  name: 'Pipeline',
  description: null,
  config: {
    version: 1,
    filters: [{ id: 'rep', label: 'Rep', kind: 'user', targets: [{ tableId: 7, fieldId: 5 }] }],
  },
  revision: 1,
  created_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
};

function widget(id: number, type: TableDashboardWidget['type'], title: string, card: object): TableDashboardWidget {
  return {
    id,
    dashboard_id: 11,
    table_id: 7,
    type,
    title,
    config: JSON.stringify({ version: 2, card }),
    layout: JSON.stringify({ x: 0, y: 0, w: 6, h: 4 }),
    position: 0,
    revision: 1,
    created_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
  };
}

const kpiCard = { kind: 'kpi', source: { tableId: 7 }, aggregate: { operation: 'count' } };
const pivotCard = {
  kind: 'pivot',
  source: { tableId: 7 },
  aggregate: { operation: 'count', groupBy: { fieldId: 2 }, series: { fieldId: 5 } },
};

const acme: TableRecord = {
  id: 42,
  table_id: 7,
  values: { '1': 'Acme', '2': 'won', '5': 'u1' },
  computed_values: {},
  revision: 1,
  created_by: 'u1',
  updated_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
  deleted_at: null,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  api.getTableDashboard.mockResolvedValue({
    dashboard,
    widgets: [widget(21, 'kpi', 'Deals', kpiCard), widget(22, 'pivot', 'By stage', pivotCard)],
  });
  api.getTableSchema.mockResolvedValue({ table, fields, views: [] });
  api.listTableUsers.mockResolvedValue([{ id: 'u1', nickname: 'Jim', email: 'jim@example.com', role: 'team' }]);
  api.queryTableDashboardWidget.mockImplementation(async (widgetId: number, input: { drilldown?: unknown }) => {
    if (input.drilldown) {
      return {
        widget: {},
        card: pivotCard,
        result: { kind: 'records', page: { records: [acme], total: 1, nextCursor: null } },
      };
    }
    return widgetId === 21
      ? { widget: {}, card: kpiCard, result: { kind: 'kpi', value: 12 } }
      : { widget: {}, card: pivotCard, result: { kind: 'pivot', rows: [{ group: 'won', series: 'u1', value: 4 }] } };
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.location.hash = '#/tables/3/dashboard/11';
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

async function mount() {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <TablesDashboardView dashboardId={11} tables={[table]} role="viewer" />
      </I18nProvider>,
    );
  });
  await flush();
}

function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find(
    (entry) => entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label,
  );
  if (!button) throw new Error(`no button "${label}"`);
  return act(async () => (button as HTMLButtonElement).click());
}

describe('TablesDashboardView', () => {
  it('evaluates widgets in the viewer zone and re-evaluates them when a filter changes', async () => {
    await mount();
    expect(container.querySelector('[data-testid="table-card-kpi"]')?.textContent).toBe('12');
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(api.queryTableDashboardWidget).toHaveBeenCalledWith(21, { filterValues: {}, timezone: zone });
    // A viewer sees the bar but not the builder's editors.
    expect(container.querySelector('[data-testid="dashboard-filter-bar"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Filters');

    api.queryTableDashboardWidget.mockClear();
    const select = container.querySelector('select[aria-label="Rep"]') as HTMLSelectElement;
    await act(async () => {
      select.value = '$me';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(api.queryTableDashboardWidget).toHaveBeenCalledWith(22, {
      filterValues: { rep: { kind: 'user', userIds: ['$me'] } },
      timezone: zone,
    });
  });

  it('drills from a pivot cell into a drawer of records and opens one', async () => {
    await mount();
    await clickButton('Show records for Won · Jim');
    await flush();
    expect(api.queryTableDashboardWidget).toHaveBeenLastCalledWith(
      22,
      expect.objectContaining({ drilldown: { group: 'won', series: 'u1' }, filterValues: {} }),
    );
    const drawer = document.querySelector('[data-testid="dashboard-drilldown"]');
    expect(drawer?.textContent).toContain('Acme');
    expect(document.body.textContent).toContain('By stage: Won · Jim');
    await clickButton('Open Acme');
    expect(window.location.hash).toBe('#/tables/3/table/7?record=42');
  });

  it('refreshes widgets when records of their table change', async () => {
    await mount();
    api.queryTableDashboardWidget.mockClear();
    await act(async () => realtime.onChange?.([{ tableId: 99 }]));
    await flush();
    expect(api.queryTableDashboardWidget).not.toHaveBeenCalled();
    await act(async () => realtime.onChange?.([{ tableId: 7 }]));
    await flush();
    expect(api.queryTableDashboardWidget).toHaveBeenCalledTimes(2);
  });
});
