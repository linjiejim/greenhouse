/**
 * A dashboard's data on the client: the dashboard and its widgets, every
 * widget's evaluated result for the current filter values and the viewer's
 * time zone, the schemas the cards need for labels, and refreshes when records
 * of those tables change (`tables:records_changed`).
 *
 * Each widget loads and fails on its own — one broken widget never blanks the
 * dashboard — and a refresh keeps the previous result on screen until the new
 * one arrives. Only a widget's latest request lands: a slow answer for an
 * earlier filter value never replaces the one for the current value.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { legacyWidgetToCard } from '@greenhouse/types/table-cards';
import type { TableCardSpec, TableDashboardWidgetConfig } from '@greenhouse/types/tables';
import {
  getTableDashboard,
  getTableSchema,
  queryTableDashboardWidget,
  type TableDashboard,
  type TableDashboardWidget,
  type TableField,
} from '../../../lib/api/tables';
import {
  useTableCardResults,
  type DashboardFilterValues,
  type TableCardDataProvider,
  type TableCardState,
} from '../../../components/table-cards';
import { useTablesRecordsChanged } from '../../../hooks/use-tables-records-changed';
import { safeParse } from '../../../lib/utils';

/** A widget's evaluated card on the client — the shared card state (`components/table-cards`). */
export type WidgetState = TableCardState;

/** The card a widget row describes (legacy flat configs mapped), as stored. */
export function storedWidgetCard(widget: TableDashboardWidget): TableCardSpec {
  return legacyWidgetToCard(widget.type, safeParse<TableDashboardWidgetConfig>(widget.config, {}), widget.table_id);
}

export function useDashboardData(dashboardId: number, filterValues: DashboardFilterValues) {
  const [dashboard, setDashboard] = useState<TableDashboard | null>(null);
  const [widgets, setWidgets] = useState<TableDashboardWidget[]>([]);
  const [fieldsByTable, setFieldsByTable] = useState<ReadonlyMap<number, TableField[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const schemaCache = useRef(new Map<number, Promise<TableField[]>>());

  /** One table's fields as the viewer may read them; cached per dashboard. */
  const loadFields = useCallback((tableId: number) => {
    let pending = schemaCache.current.get(tableId);
    if (!pending) {
      pending = getTableSchema(tableId).then((schema) => schema.fields);
      pending.catch(() => schemaCache.current.delete(tableId));
      schemaCache.current.set(tableId, pending);
    }
    return pending;
  }, []);

  /** The dashboard's card source: each widget is evaluated by its own query route. */
  const provider = useMemo<TableCardDataProvider<number>>(
    () => ({
      query: async (widgetId, input) => {
        const { card, result } = await queryTableDashboardWidget(widgetId, input);
        return { card, result };
      },
      loadFields,
    }),
    [loadFields],
  );
  const { states, timezone, query, queryMany } = useTableCardResults(provider, filterValues);

  const queryWidget = useCallback((widget: TableDashboardWidget) => query(widget.id), [query]);
  const queryWidgets = useCallback(
    (list: readonly TableDashboardWidget[]) => queryMany(list.map((widget) => widget.id)),
    [queryMany],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    schemaCache.current.clear();
    try {
      const next = await getTableDashboard(dashboardId);
      setDashboard(next.dashboard);
      setWidgets(next.widgets);
      const tableIds = new Set<number>();
      for (const widget of next.widgets) if (widget.table_id) tableIds.add(widget.table_id);
      for (const control of next.dashboard.config?.filters ?? []) {
        for (const target of control.targets) tableIds.add(target.tableId);
      }
      const schemas = await Promise.all(
        [...tableIds].map(async (tableId) => [tableId, await loadFields(tableId).catch(() => [])] as const),
      );
      setFieldsByTable(new Map(schemas));
      await queryWidgets(next.widgets);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [dashboardId, loadFields, queryWidgets]);

  useEffect(() => {
    void load();
  }, [load]);

  // New filter values re-evaluate every data widget (the first render is load's).
  const filterKey = JSON.stringify(filterValues);
  const lastFilterKey = useRef(filterKey);
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;
  useEffect(() => {
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    void queryWidgets(widgetsRef.current.filter((widget) => widget.type !== 'text'));
  }, [filterKey, queryWidgets]);

  // Someone (a person, a form, an automation) changed records: refresh the widgets reading those tables.
  useTablesRecordsChanged(
    { baseId: dashboard?.base_id },
    (events) => {
      const tables = new Set(events.map((event) => event.tableId));
      // Returned, so a burst (an import's chunks) waits for this refresh instead of stacking more.
      return queryWidgets(widgetsRef.current.filter((widget) => widget.table_id && tables.has(widget.table_id)));
    },
    { enabled: dashboard !== null },
  );

  return {
    dashboard,
    setDashboard,
    widgets,
    setWidgets,
    states,
    fieldsByTable,
    loading,
    error,
    setError,
    timezone,
    load,
    loadFields,
    queryWidget,
  };
}
