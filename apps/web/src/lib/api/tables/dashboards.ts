/**
 * Tables client · dashboards and their widgets.
 */

import type {
  TableAggregateRow,
  TableDashboardWidgetConfig,
  TableDashboardWidgetLayout,
  TableDashboardWidgetType,
} from '@greenhouse/types/tables';
import { rpc } from '../client';
import { responseError } from './shared';
import type { TableRecordPage } from './records';

export interface TableDashboard {
  id: number;
  base_id: number;
  name: string;
  description: string | null;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TableDashboardWidget {
  id: number;
  dashboard_id: number;
  table_id: number | null;
  type: TableDashboardWidgetType;
  title: string;
  /** JSON-encoded `TableDashboardWidgetConfig`. */
  config: string;
  /** JSON-encoded `TableDashboardWidgetLayout`. */
  layout: string;
  position: number;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TableDashboardWidgetResult {
  widget: TableDashboardWidget;
  text?: string;
  rows?: TableAggregateRow[];
  records?: TableRecordPage;
}

export async function createTableDashboard(baseId: number, name: string): Promise<TableDashboard> {
  const args = { param: { baseId: String(baseId) }, json: { name } };
  const response = await rpc.api.tables.bases[':baseId'].dashboards.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create dashboard');
  return (await response.json()).dashboard;
}

export async function updateTableDashboard(
  dashboardId: number,
  input: { revision: number; name?: string; description?: string | null },
): Promise<TableDashboard> {
  const args = { param: { dashboardId: String(dashboardId) }, json: input };
  const response = await rpc.api.tables.dashboards[':dashboardId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update dashboard');
  return (await response.json()).dashboard;
}

/** Unlike Bases and tables, a dashboard is pure configuration and really goes (spec D4). */
export async function deleteTableDashboard(dashboardId: number): Promise<void> {
  const response = await rpc.api.tables.dashboards[':dashboardId'].$delete({
    param: { dashboardId: String(dashboardId) },
  });
  if (!response.ok) throw await responseError(response, 'Unable to delete dashboard');
}

export async function getTableDashboard(
  dashboardId: number,
): Promise<{ dashboard: TableDashboard; widgets: TableDashboardWidget[] }> {
  const response = await rpc.api.tables.dashboards[':dashboardId'].$get({
    param: { dashboardId: String(dashboardId) },
  });
  if (!response.ok) throw await responseError(response, 'Unable to load dashboard');
  return response.json();
}

export async function createTableDashboardWidget(
  dashboardId: number,
  input: {
    tableId?: number;
    type: TableDashboardWidgetType;
    title: string;
    config?: TableDashboardWidgetConfig;
    layout?: TableDashboardWidgetLayout;
  },
): Promise<TableDashboardWidget> {
  const args = { param: { dashboardId: String(dashboardId) }, json: input };
  const response = await rpc.api.tables.dashboards[':dashboardId'].widgets.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create widget');
  return (await response.json()).widget;
}

export async function updateTableDashboardWidget(
  widgetId: number,
  input: {
    revision: number;
    tableId?: number | null;
    title?: string;
    config?: TableDashboardWidgetConfig;
    layout?: TableDashboardWidgetLayout;
    position?: number;
  },
): Promise<TableDashboardWidget> {
  const args = { param: { widgetId: String(widgetId) }, json: input };
  const response = await rpc.api.tables['dashboard-widgets'][':widgetId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update widget');
  return (await response.json()).widget;
}

export async function deleteTableDashboardWidget(widgetId: number): Promise<void> {
  const response = await rpc.api.tables['dashboard-widgets'][':widgetId'].$delete({
    param: { widgetId: String(widgetId) },
  });
  if (!response.ok) throw await responseError(response, 'Unable to delete widget');
}

export async function queryTableDashboardWidget(widgetId: number): Promise<TableDashboardWidgetResult> {
  const response = await rpc.api.tables['dashboard-widgets'][':widgetId'].query.$post({
    param: { widgetId: String(widgetId) },
  });
  if (!response.ok) throw await responseError(response, 'Unable to query widget');
  return response.json();
}
