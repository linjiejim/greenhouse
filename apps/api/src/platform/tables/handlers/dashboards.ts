/**
 * Dashboards and widgets. Slice D replaces the widget evaluator with the shared
 * card evaluator (`platform/tables/cards.ts`) and adds dashboard filters.
 */

import { effectiveUserId } from '@greenhouse/platform-kernel';
import {
  TABLE_DASHBOARD_WIDGET_TYPES,
  type TableDashboardWidgetConfig,
  type TableDashboardWidgetLayout,
  type TableDashboardWidgetType,
} from '@greenhouse/types/tables';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { DatabaseProvider, TableBaseRow } from '@greenhouse/db';
import {
  baseForDashboard,
  baseForWidget,
  customAccessLens,
  requireBase,
  requireTableData,
  type CustomAccessLens,
} from '../access.js';
import { trimDashboard, trimWidget, widgetAccessible } from '../access-trim.js';
import {
  fail,
  nullableString,
  objectValue,
  ok,
  optionalNumber,
  payloadOf,
  positiveInt,
  stringValue,
  type Handler,
  type TablesHandlers,
} from './shared.js';

/** A widget's table must belong to the dashboard's Base. */
async function tableInBase(db: DatabaseProvider, tableId: number, base: TableBaseRow): Promise<boolean> {
  const table = await db.tables.getTable(tableId);
  return Boolean(table && table.base_id === base.id);
}

/**
 * Read access to a Base's dashboards: built-in viewers and up, or a custom role
 * whose rules say `dashboards: 'all'` (its lens comes back for trimming).
 * Undefined = 404, the same as a missing dashboard (slice A).
 */
async function dashboardReader(
  request: Parameters<Handler>[0],
  context: Parameters<Handler>[1],
  baseId: number,
  entityId: 'dashboard' | 'dashboardWidget',
): Promise<{ lens: CustomAccessLens | undefined } | undefined> {
  const grant = await requireBase(context, request.actor, baseId, entityId, 'viewer', { allowCustom: true });
  if (!grant) return undefined;
  const lens = await customAccessLens(context, grant.access, effectiveUserId(request.actor));
  if (lens && lens.rules.dashboards !== 'all') return undefined;
  return { lens };
}

const listDashboards: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  if (!(await dashboardReader(request, context, baseId, 'dashboard'))) return fail('NOT_FOUND', 'Base not found');
  return ok({ dashboards: await context.db.tables.listDashboards(baseId) });
};

const getDashboard: Handler = async (request, context) => {
  const dashboardId = positiveInt(payloadOf(request), 'dashboardId');
  if (!dashboardId) return fail('INVALID_INPUT', 'dashboardId is required');
  const base = await baseForDashboard(context.db, dashboardId);
  const reader = base && (await dashboardReader(request, context, base.id, 'dashboard'));
  if (!reader) return fail('NOT_FOUND', 'Dashboard not found');
  const dashboard = await context.db.tables.getDashboard(dashboardId);
  if (!dashboard) return fail('NOT_FOUND', 'Dashboard not found');
  return ok(reader.lens ? trimDashboard(reader.lens, dashboard) : dashboard);
};

const createDashboard: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const baseId = positiveInt(payload, 'baseId');
  const name = stringValue(payload, 'name');
  if (!baseId || !name) return fail('INVALID_INPUT', 'baseId and name are required');
  if (!(await requireBase(context, request.actor, baseId, 'dashboard', 'builder'))) {
    return fail('NOT_FOUND', 'Base not found');
  }
  const dashboard = await context.db.tables.createDashboard({
    base_id: baseId,
    name,
    description: stringValue(payload, 'description'),
    created_by: effectiveUserId(request.actor),
  });
  return ok({ dashboard });
};

const updateDashboard: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const dashboardId = positiveInt(payload, 'dashboardId');
  const revision = positiveInt(payload, 'revision');
  if (!dashboardId || !revision) return fail('INVALID_INPUT', 'dashboardId and revision are required');
  const base = await baseForDashboard(context.db, dashboardId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'dashboard', 'builder'))) {
    return fail('NOT_FOUND', 'Dashboard not found');
  }
  const result = await context.db.tables.updateDashboard(dashboardId, {
    revision,
    name: stringValue(payload, 'name'),
    description: nullableString(payload, 'description'),
  });
  if (result.ok) return ok({ dashboard: result.value });
  return result.reason === 'conflict'
    ? fail('CONFLICT', 'Dashboard revision conflict', { currentRevision: result.current })
    : fail('NOT_FOUND', 'Dashboard not found');
};

/**
 * A real delete, unlike bases/tables/records — a dashboard holds only widget
 * configuration, so there is nothing to recover and no archive shelf to build
 * (spec D4). Owner-gated all the same: it is shared furniture.
 */
const deleteDashboard: Handler = async (request, context) => {
  const dashboardId = positiveInt(payloadOf(request), 'dashboardId');
  if (!dashboardId) return fail('INVALID_INPUT', 'dashboardId is required');
  const base = await baseForDashboard(context.db, dashboardId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'dashboard', 'owner'))) {
    return fail('NOT_FOUND', 'Dashboard not found');
  }
  const deleted = await context.db.tables.deleteDashboard(dashboardId);
  return deleted ? ok({ success: true as const }) : fail('NOT_FOUND', 'Dashboard not found');
};

const createDashboardWidget: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const dashboardId = positiveInt(payload, 'dashboardId');
  const title = stringValue(payload, 'title');
  const type = stringValue(payload, 'type') as TableDashboardWidgetType | undefined;
  if (!dashboardId || !title || !type) return fail('INVALID_INPUT', 'dashboardId, title, and type are required');
  if (!TABLE_DASHBOARD_WIDGET_TYPES.includes(type)) {
    return fail('INVALID_INPUT', `Unsupported dashboard widget type "${type}"`);
  }
  const base = await baseForDashboard(context.db, dashboardId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'dashboardWidget', 'builder'))) {
    return fail('NOT_FOUND', 'Dashboard not found');
  }
  const tableId = positiveInt(payload, 'tableId');
  if (tableId && !(await tableInBase(context.db, tableId, base))) {
    return fail('INVALID_INPUT', 'Widget table must belong to this Base');
  }
  const widget = await context.db.tables.createDashboardWidget({
    dashboard_id: dashboardId,
    table_id: tableId,
    type,
    title,
    config: objectValue<TableDashboardWidgetConfig>(payload, 'config'),
    layout: objectValue<TableDashboardWidgetLayout>(payload, 'layout'),
    position: optionalNumber(payload, 'position'),
    created_by: effectiveUserId(request.actor),
  });
  return ok({ widget });
};

const updateDashboardWidget: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const widgetId = positiveInt(payload, 'widgetId');
  const revision = positiveInt(payload, 'revision');
  if (!widgetId || !revision) return fail('INVALID_INPUT', 'widgetId and revision are required');
  const base = await baseForWidget(context.db, widgetId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'dashboardWidget', 'builder'))) {
    return fail('NOT_FOUND', 'Widget not found');
  }
  const tableId = payload.tableId === null ? null : positiveInt(payload, 'tableId');
  if (tableId && !(await tableInBase(context.db, tableId, base))) {
    return fail('INVALID_INPUT', 'Widget table must belong to this Base');
  }
  const result = await context.db.tables.updateDashboardWidget(widgetId, {
    revision,
    table_id: payload.tableId === undefined ? undefined : tableId,
    title: stringValue(payload, 'title'),
    config: objectValue<TableDashboardWidgetConfig>(payload, 'config'),
    layout: objectValue<TableDashboardWidgetLayout>(payload, 'layout'),
    position: optionalNumber(payload, 'position'),
  });
  if (result.ok) return ok({ widget: result.value });
  return result.reason === 'conflict'
    ? fail('CONFLICT', 'Widget revision conflict', { currentRevision: result.current })
    : fail('NOT_FOUND', 'Widget not found');
};

const deleteDashboardWidget: Handler = async (request, context) => {
  const widgetId = positiveInt(payloadOf(request), 'widgetId');
  if (!widgetId) return fail('INVALID_INPUT', 'widgetId is required');
  const base = await baseForWidget(context.db, widgetId);
  if (!base || !(await requireBase(context, request.actor, base.id, 'dashboardWidget', 'builder'))) {
    return fail('NOT_FOUND', 'Widget not found');
  }
  return (await context.db.tables.deleteDashboardWidget(widgetId))
    ? ok({ success: true })
    : fail('NOT_FOUND', 'Widget not found');
};

const queryDashboardWidget: Handler = async (request, context) => {
  const widgetId = positiveInt(payloadOf(request), 'widgetId');
  if (!widgetId) return fail('INVALID_INPUT', 'widgetId is required');
  const base = await baseForWidget(context.db, widgetId);
  const reader = base && (await dashboardReader(request, context, base.id, 'dashboardWidget'));
  if (!reader) return fail('NOT_FOUND', 'Widget not found');
  const widget = await context.db.tables.getDashboardWidget(widgetId);
  if (!widget) return fail('NOT_FOUND', 'Widget not found');
  // A custom role never evaluates a widget that depends on what it cannot read.
  if (reader.lens && !widgetAccessible(reader.lens, widget)) {
    return ok({ widget: trimWidget(reader.lens, widget), noAccess: true });
  }
  const config = safeJsonParse(widget.config, {}) as TableDashboardWidgetConfig;
  if (widget.type === 'text') return ok({ widget, text: config.text ?? '' });
  if (!widget.table_id) return fail('INVALID_INPUT', 'Widget has no table');
  const data = await requireTableData(request, context, widget.table_id, 'read');
  if (!data) return fail('NOT_FOUND', 'Widget table not found');
  if (widget.type === 'records') {
    const result = await context.db.tables.queryRecords(
      widget.table_id,
      { ...(config.query ?? {}), limit: Math.min(Math.max(config.limit ?? 20, 1), 100) },
      data.scope,
    );
    return ok({ widget, records: { ...result, records: result.records.map((record) => data.project(record)) } });
  }
  const rows = await context.db.tables.aggregateRecords(
    widget.table_id,
    {
      operation: config.operation ?? 'count',
      valueFieldId: config.valueFieldId,
      groupByFieldId: widget.type === 'kpi' ? undefined : config.groupByFieldId,
      query: config.query,
      limit: config.limit,
    },
    data.scope,
  );
  return ok({ widget, rows });
};

export const dashboardHandlers = {
  listDashboards,
  getDashboard,
  createDashboard,
  updateDashboard,
  deleteDashboard,
  createDashboardWidget,
  updateDashboardWidget,
  deleteDashboardWidget,
  queryDashboardWidget,
} satisfies TablesHandlers;
