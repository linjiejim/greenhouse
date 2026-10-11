/**
 * A Tables dashboard: the viewer's filter bar, the widget grid (each widget a
 * shared table card evaluated server-side for this viewer, filters and time
 * zone), drill-down into the records behind a point, and — for builders — the
 * widget editor, the filter editor and layout drag / resize.
 *
 * Data and refresh live in `dashboard/use-dashboard-data.ts`; the editors in
 * `dashboard/*-dialog.tsx`; card renderers in `components/table-cards/`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { tableRoleAtLeast } from '@greenhouse/types/table-access';
import type { TableCardPoint } from '@greenhouse/types/table-cards';
import type { TableBaseRole, TableCardSpec, TableDashboardWidgetLayout } from '@greenhouse/types/tables';
import {
  deleteTableDashboardWidget,
  listTableUsers,
  queryTableDashboardWidget,
  updateTableDashboardWidget,
  type TableDashboardWidget,
  type TableDefinition,
  type TableRecord,
  type TableUser,
} from '../../lib/api/tables';
import { Button, ConfirmDialog, EmptyState, Spinner } from '../../components/ui';
import { WidgetGrid, type WidgetGridItem } from '../../components/workbench/widget-grid';
import {
  DrilldownDrawer,
  FilterBar,
  type DashboardFilterValues,
  type DrilldownRequest,
} from '../../components/table-cards';
import { BarChart3, Filter, Plus } from '../../lib/icons';
import { safeParse } from '../../lib/utils';
import { useT } from '../../lib/i18n';
import { FilterControlsDialog } from './dashboard/filter-controls-dialog';
import { storedWidgetCard, useDashboardData } from './dashboard/use-dashboard-data';
import { WidgetDialog } from './dashboard/widget-dialog';
import { WidgetFrame } from './dashboard/widget-frame';

interface TablesDashboardViewProps {
  dashboardId: number;
  tables: TableDefinition[];
  role: TableBaseRole;
}

/**
 * Twelve columns, matching the Home workbench. Stored layouts were written
 * against a 12-column mental model (`w:6` = half width).
 */
const DASHBOARD_COLUMNS = 12;

export function TablesDashboardView({ dashboardId, tables, role }: TablesDashboardViewProps) {
  const t = useT();
  const canBuild = tableRoleAtLeast(role, 'builder');
  const [filterValues, setFilterValues] = useState<DashboardFilterValues>({});
  const data = useDashboardData(dashboardId, filterValues);
  const { dashboard, widgets, states, fieldsByTable } = data;
  const [users, setUsers] = useState<TableUser[]>([]);
  const [widgetDialog, setWidgetDialog] = useState<
    { widget: TableDashboardWidget; card: TableCardSpec } | 'new' | null
  >(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [deleteWidget, setDeleteWidget] = useState<TableDashboardWidget | null>(null);
  const [drill, setDrill] = useState<(DrilldownRequest & { tableId: number; card: TableCardSpec | null }) | null>(null);

  useEffect(() => {
    void listTableUsers()
      .then(setUsers)
      .catch(() => setUsers([]));
  }, []);
  // Another dashboard: its own filters.
  useEffect(() => setFilterValues({}), [dashboardId]);

  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const controls = dashboard?.config?.filters ?? [];

  /**
   * Grid items for the shared widget grid. Position is taken as stored; only
   * the size is clamped up to something usable for the widget type, so legacy
   * defaults (`w:1|2,h:1`) never render as a sliver.
   */
  const gridItems: WidgetGridItem[] = useMemo(
    () =>
      widgets.map((widget) => {
        const compact = widget.type === 'kpi' || widget.type === 'text';
        const minW = compact ? 3 : 6;
        // A KPI needs its number and caption row below the title; text can be a one-liner.
        const minH = widget.type === 'kpi' ? 3 : compact ? 2 : 4;
        const layout = safeParse<Partial<TableDashboardWidgetLayout>>(widget.layout, {});
        const w = Math.min(Math.max(typeof layout.w === 'number' ? layout.w : minW, minW), DASHBOARD_COLUMNS);
        return {
          id: String(widget.id),
          x: Math.min(layout.x ?? 0, DASHBOARD_COLUMNS - w),
          y: layout.y ?? 0,
          w,
          h: Math.max(typeof layout.h === 'number' ? layout.h : minH, minH),
          minW,
          minH,
        };
      }),
    [widgets],
  );
  const widgetsById = useMemo(() => new Map(widgets.map((widget) => [widget.id, widget])), [widgets]);

  const persistLayout = useCallback(
    (items: WidgetGridItem[]) => {
      const byId = new Map(items.map((item) => [Number(item.id), item]));
      data.setWidgets((previous) =>
        previous.map((widget) => {
          const item = byId.get(widget.id);
          return item ? { ...widget, layout: JSON.stringify({ x: item.x, y: item.y, w: item.w, h: item.h }) } : widget;
        }),
      );
      void Promise.all(
        widgets.map(async (widget) => {
          const item = byId.get(widget.id);
          if (!item) return;
          const layout = { x: item.x, y: item.y, w: item.w, h: item.h };
          const current = safeParse<Partial<TableDashboardWidgetLayout>>(widget.layout, {});
          if (current.x === layout.x && current.y === layout.y && current.w === layout.w && current.h === layout.h) {
            return;
          }
          const saved = await updateTableDashboardWidget(widget.id, { revision: widget.revision, layout });
          data.setWidgets((previous) => previous.map((entry) => (entry.id === saved.id ? saved : entry)));
        }),
      ).catch((layoutError) => {
        data.setError(layoutError instanceof Error ? layoutError.message : t('tables.dashboard.saveWidgetFailed'));
      });
    },
    [data, t, widgets],
  );

  const openDrill = (widget: TableDashboardWidget, point: TableCardPoint, label: string) => {
    const tableId = widget.table_id;
    if (!tableId) return;
    const values = filterValues;
    setDrill({
      key: `${widget.id}:${JSON.stringify(point)}:${JSON.stringify(values)}:${Date.now()}`,
      title: t('tables.dashboard.drilldown.title', { widget: widget.title, label }),
      tableId,
      card: states[widget.id]?.card ?? null,
      load: async (cursor) => {
        const response = await queryTableDashboardWidget(widget.id, {
          filterValues: values,
          timezone: data.timezone,
          drilldown: point,
          ...(cursor ? { cursor } : {}),
        });
        if (response.result.kind !== 'records') throw new Error(t('tables.dashboard.drilldown.failed'));
        return response.result.page;
      },
    });
  };

  const openRecord = (record: TableRecord) => {
    if (!dashboard) return;
    window.location.hash = `#/tables/${dashboard.base_id}/table/${record.table_id}?record=${record.id}`;
  };

  if (data.loading && !dashboard) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-fg-faint" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-surface-canvas">
      <header className="sticky top-0 z-10 border-b border-edge bg-surface-raised/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-fg" title={dashboard?.name}>
              {dashboard?.name ?? t('tables.dashboard.title')}
            </h2>
            <p className="truncate text-xs text-fg-faint" title={dashboard?.description ?? undefined}>
              {dashboard?.description || t('tables.dashboard.description')}
            </p>
          </div>
          {canBuild && dashboard && (
            <div className="flex flex-shrink-0 gap-2">
              <Button variant="outline" size="sm" onClick={() => setFiltersOpen(true)} className="gap-1.5">
                <Filter size={13} />
                {t('tables.dashboard.filters.edit')}
              </Button>
              <Button size="sm" onClick={() => setWidgetDialog('new')} className="gap-1.5">
                <Plus size={13} />
                {t('tables.dashboard.widget')}
              </Button>
            </div>
          )}
        </div>
        {controls.length > 0 && (
          <div className="mt-3">
            <FilterBar
              controls={controls}
              values={filterValues}
              onChange={setFilterValues}
              fieldsByTable={fieldsByTable}
              users={users}
            />
          </div>
        )}
      </header>
      {data.error && (
        <div className="border-b border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">{data.error}</div>
      )}
      <div className="p-4 sm:p-6">
        {widgets.length === 0 ? (
          <EmptyState
            icon={BarChart3}
            title={t('tables.dashboard.emptyTitle')}
            description={canBuild ? t('tables.dashboard.emptyBuilder') : t('tables.dashboard.emptyViewer')}
          />
        ) : (
          <WidgetGrid
            items={gridItems}
            editing={canBuild}
            columns={DASHBOARD_COLUMNS}
            onLayoutChange={persistLayout}
            renderItem={(id) => {
              const widget = widgetsById.get(Number(id));
              if (!widget) return null;
              return (
                <WidgetFrame
                  widget={widget}
                  state={states[widget.id]}
                  fields={widget.table_id ? fieldsByTable.get(widget.table_id) : undefined}
                  usersById={usersById}
                  canBuild={canBuild}
                  onEdit={() => setWidgetDialog({ widget, card: storedWidgetCard(widget) })}
                  onDelete={() => setDeleteWidget(widget)}
                  onDrill={(point, label) => openDrill(widget, point, label)}
                  onOpenRecord={openRecord}
                  onRetry={() => void data.queryWidget(widget)}
                />
              );
            }}
          />
        )}
      </div>

      <DrilldownDrawer
        request={drill}
        fields={drill ? (fieldsByTable.get(drill.tableId) ?? []) : []}
        fieldIds={drill?.card?.kind === 'records' ? drill.card.fieldIds : undefined}
        usersById={usersById}
        onClose={() => setDrill(null)}
        onOpenRecord={openRecord}
      />
      {canBuild && (
        <WidgetDialog
          open={widgetDialog !== null}
          dashboardId={dashboardId}
          editing={widgetDialog === 'new' ? null : widgetDialog}
          tables={tables}
          users={users}
          loadFields={data.loadFields}
          onClose={() => setWidgetDialog(null)}
          onSaved={() => {
            setWidgetDialog(null);
            void data.load();
          }}
        />
      )}
      {canBuild && dashboard && (
        <FilterControlsDialog
          open={filtersOpen}
          dashboard={dashboard}
          tables={tables}
          loadFields={data.loadFields}
          onClose={() => setFiltersOpen(false)}
          onSaved={() => {
            setFiltersOpen(false);
            setFilterValues({});
            void data.load();
          }}
        />
      )}
      <ConfirmDialog
        open={deleteWidget !== null}
        onClose={() => setDeleteWidget(null)}
        onConfirm={() => {
          if (!deleteWidget) return;
          void deleteTableDashboardWidget(deleteWidget.id).then(async () => {
            setDeleteWidget(null);
            await data.load();
          });
        }}
        title={t('tables.dashboard.deleteTitle', { name: deleteWidget?.title ?? t('tables.dashboard.widget') })}
        description={t('tables.dashboard.deleteDescription')}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </div>
  );
}
