/**
 * Tables · dashboards and widgets — mounted at /api/tables (endpoint list in ./index.ts).
 */

import { Hono } from 'hono';
import type {
  TableDashboardResult,
  TableDashboardRow,
  TableDashboardWidgetRow,
  TableRecordQueryResult,
} from '@greenhouse/db';
import type { TableCardSpec } from '@greenhouse/types/tables';
import type { TableCardResult } from '@greenhouse/types/table-cards';
import type { AppEnv } from '../../app-env.js';
import { actionError, dispatch, jsonBody, numberParam } from './shared.js';

export const dashboardRoutes = new Hono<AppEnv>()
  .get('/bases/:baseId/dashboards', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'listDashboards', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { dashboards: TableDashboardRow[] });
  })
  .post('/bases/:baseId/dashboards', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'createDashboard', { ...(await jsonBody(c)), baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { dashboard: TableDashboardRow }, 201);
  })
  .get('/dashboards/:dashboardId', async (c) => {
    const dashboardId = numberParam(c, 'dashboardId');
    const result = await dispatch(c, 'getDashboard', { dashboardId }, { dashboardId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableDashboardResult);
  })
  .patch('/dashboards/:dashboardId', async (c) => {
    const dashboardId = numberParam(c, 'dashboardId');
    const result = await dispatch(c, 'updateDashboard', { ...(await jsonBody(c)), dashboardId }, { dashboardId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { dashboard: TableDashboardRow });
  })
  .delete('/dashboards/:dashboardId', async (c) => {
    const dashboardId = numberParam(c, 'dashboardId');
    const result = await dispatch(c, 'deleteDashboard', { dashboardId }, { dashboardId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { success: true });
  })
  .post('/dashboards/:dashboardId/widgets', async (c) => {
    const dashboardId = numberParam(c, 'dashboardId');
    const result = await dispatch(c, 'createDashboardWidget', { ...(await jsonBody(c)), dashboardId }, { dashboardId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { widget: TableDashboardWidgetRow }, 201);
  })
  .patch('/dashboard-widgets/:widgetId', async (c) => {
    const widgetId = numberParam(c, 'widgetId');
    const result = await dispatch(c, 'updateDashboardWidget', { ...(await jsonBody(c)), widgetId }, { widgetId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { widget: TableDashboardWidgetRow });
  })
  .delete('/dashboard-widgets/:widgetId', async (c) => {
    const widgetId = numberParam(c, 'widgetId');
    const result = await dispatch(c, 'deleteDashboardWidget', { widgetId }, { widgetId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { success: true });
  })
  // Body: {filterValues?, timezone?, drilldown?: {group, series?}, cursor?} — see queryDashboardWidget.
  .post('/dashboard-widgets/:widgetId/query', async (c) => {
    const widgetId = numberParam(c, 'widgetId');
    const result = await dispatch(c, 'queryDashboardWidget', { ...(await jsonBody(c)), widgetId }, { widgetId });
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        widget: TableDashboardWidgetRow & { access?: 'no_access' };
        card: TableCardSpec | null;
        result: TableCardResult<TableRecordQueryResult>;
      },
    );
  });
