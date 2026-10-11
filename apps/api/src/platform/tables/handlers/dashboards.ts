/**
 * Dashboards and widgets. Widgets store a `TableCardSpec` and are evaluated by
 * the shared card evaluator (`../cards.ts`) with the dashboard's filter
 * controls, the viewer's filter values and time zone, and the viewer's scope.
 *
 * Who sees what:
 * - built-in roles: viewer+ reads dashboards (configuration as stored),
 *   builder+ changes them, owner deletes them;
 * - a custom role reads dashboards only when its rules say `dashboards: 'all'`
 *   (otherwise every read answers 404), and then sees them trimmed: a widget on
 *   a table it cannot read, or whose query needs a hidden field, comes back as
 *   `no_access` with its configuration withheld; hidden record columns are
 *   dropped; filter targets on hidden fields are removed (a control left empty
 *   disappears) and the evaluator ignores any value sent for them.
 */

import { effectiveUserId } from '@greenhouse/platform-kernel';
import {
  TABLE_DASHBOARD_WIDGET_TYPES,
  type TableCardSpec,
  type TableDashboardConfig,
  type TableDashboardWidgetConfig,
  type TableDashboardWidgetLayout,
  type TableDashboardWidgetType,
} from '@greenhouse/types/tables';
import {
  legacyWidgetToCard,
  normalizeDashboardConfig,
  normalizeTableCardSpec,
  trimCardForReader,
  trimFilterControlsForReader,
  widgetTypeForCard,
  type TableCardPoint,
} from '@greenhouse/types/table-cards';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { DatabaseProvider, TableBaseRow, TableDashboardRow, TableDashboardWidgetRow } from '@greenhouse/db';
import { baseForDashboard, baseForWidget, requireBase, requireTableData, type BaseAccessGrant } from '../access.js';
import { evaluateTableCard } from '../cards.js';
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
  type HandlerRequest,
  type TablesHandlers,
} from './shared.js';

/** A widget's table must belong to the dashboard's Base. */
async function tableInBase(db: DatabaseProvider, tableId: number, base: TableBaseRow): Promise<boolean> {
  const table = await db.tables.getTable(tableId);
  return Boolean(table && table.base_id === base.id);
}

/**
 * The read gate for dashboards: a built-in viewer+, or a custom role whose
 * rules include dashboards. Everything else is 404.
 */
async function requireDashboardRead(
  request: HandlerRequest,
  context: Parameters<Handler>[1],
  baseId: number,
  entity: 'dashboard' | 'dashboardWidget',
): Promise<BaseAccessGrant | undefined> {
  const grant = await requireBase(context, request.actor, baseId, entity, 'viewer', { allowCustom: true });
  if (!grant) return undefined;
  if (grant.access.level === 'custom' && grant.access.customRole?.rules.dashboards !== 'all') return undefined;
  return grant;
}

function widgetCardOf(widget: TableDashboardWidgetRow): TableCardSpec {
  return legacyWidgetToCard(
    widget.type,
    safeJsonParse(widget.config, {}) as TableDashboardWidgetConfig,
    widget.table_id,
  );
}

function filterControlsOf(dashboard: Pick<TableDashboardRow, 'config'>) {
  const result = normalizeDashboardConfig(dashboard.config);
  return result.ok ? result.config.filters : [];
}

/**
 * Field ids a custom-role reader may reference, per table: undefined = the
 * table is not readable at all. Built-in roles never get here.
 */
async function customReadableFields(
  request: HandlerRequest,
  context: Parameters<Handler>[1],
  tableIds: readonly number[],
): Promise<Map<number, ReadonlySet<number> | null>> {
  const out = new Map<number, ReadonlySet<number> | null>();
  for (const tableId of new Set(tableIds)) {
    const data = await requireTableData(request, context, tableId, 'read');
    if (!data) continue;
    out.set(tableId, data.scope.kind === 'scoped' ? new Set(data.scope.readableFieldIds) : null);
  }
  return out;
}

type ViewerWidget = TableDashboardWidgetRow & { access?: 'no_access' };

/** A widget row as a restricted reader receives it: the trimmed card, or nothing but its frame. */
function widgetForReader(widget: TableDashboardWidgetRow, card: TableCardSpec | null): ViewerWidget {
  return card
    ? { ...widget, config: JSON.stringify({ version: 2, card }) }
    : { ...widget, config: JSON.stringify({ version: 2 }), access: 'no_access' };
}

function viewerTimezone(payload: Record<string, unknown>): string | undefined {
  const value = stringValue(payload, 'timezone');
  return value && value.length <= 64 ? value : undefined;
}

function isPointKey(value: unknown): value is TableCardPoint['group'] {
  return (
    value === null ||
    (typeof value === 'string' && value.length <= 500) ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** `drilldown: {group, series?}` — undefined when absent, null when malformed. */
function drilldownPoint(payload: Record<string, unknown>): TableCardPoint | undefined | null {
  if (payload.drilldown === undefined) return undefined;
  const raw = objectValue<Record<string, unknown>>(payload, 'drilldown');
  if (!raw || !isPointKey(raw.group) || (raw.series !== undefined && !isPointKey(raw.series))) return null;
  return { group: raw.group, ...(raw.series !== undefined ? { series: raw.series as TableCardPoint['series'] } : {}) };
}

const listDashboards: Handler = async (request, context) => {
  const baseId = positiveInt(payloadOf(request), 'baseId');
  if (!baseId) return fail('INVALID_INPUT', 'baseId is required');
  if (!(await requireDashboardRead(request, context, baseId, 'dashboard'))) {
    return fail('NOT_FOUND', 'Base not found');
  }
  return ok({ dashboards: await context.db.tables.listDashboards(baseId) });
};

const getDashboard: Handler = async (request, context) => {
  const dashboardId = positiveInt(payloadOf(request), 'dashboardId');
  if (!dashboardId) return fail('INVALID_INPUT', 'dashboardId is required');
  const base = await baseForDashboard(context.db, dashboardId);
  const grant = base ? await requireDashboardRead(request, context, base.id, 'dashboard') : undefined;
  if (!grant) return fail('NOT_FOUND', 'Dashboard not found');
  const result = await context.db.tables.getDashboard(dashboardId);
  if (!result) return fail('NOT_FOUND', 'Dashboard not found');
  if (grant.access.level !== 'custom') return ok(result);

  const cards = result.widgets.map(widgetCardOf);
  const controls = filterControlsOf(result.dashboard);
  const readable = await customReadableFields(request, context, [
    ...cards.flatMap((card) => (card.source ? [card.source.tableId] : [])),
    ...controls.flatMap((control) => control.targets.map((target) => target.tableId)),
  ]);
  const config: TableDashboardConfig = {
    version: 1,
    filters: trimFilterControlsForReader(controls, (tableId) => readable.get(tableId)),
  };
  return ok({
    dashboard: { ...result.dashboard, config },
    widgets: result.widgets.map((widget, index) => {
      const card = cards[index]!;
      return widgetForReader(
        widget,
        trimCardForReader(card, card.source ? readable.get(card.source.tableId) : undefined),
      );
    }),
  });
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
    config: objectValue<TableDashboardConfig>(payload, 'config'),
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
  if (payload.config !== undefined && !objectValue(payload, 'config')) {
    return fail('INVALID_INPUT', 'config must be an object');
  }
  const result = await context.db.tables.updateDashboard(dashboardId, {
    revision,
    name: stringValue(payload, 'name'),
    description: nullableString(payload, 'description'),
    config: objectValue<TableDashboardConfig>(payload, 'config'),
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

/** The stored type of a new widget: given, or implied by `config.card`. */
function requestedWidgetType(
  payload: Record<string, unknown>,
  config: TableDashboardWidgetConfig | undefined,
): TableDashboardWidgetType | string | undefined {
  const type = stringValue(payload, 'type');
  if (type || !config?.card) return type;
  const card = normalizeTableCardSpec(config.card);
  return card.ok ? widgetTypeForCard(card.card) : undefined;
}

const createDashboardWidget: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const dashboardId = positiveInt(payload, 'dashboardId');
  const title = stringValue(payload, 'title');
  const config = objectValue<TableDashboardWidgetConfig>(payload, 'config');
  const type = requestedWidgetType(payload, config);
  if (!dashboardId || !title || !type) return fail('INVALID_INPUT', 'dashboardId, title, and type are required');
  if (!TABLE_DASHBOARD_WIDGET_TYPES.includes(type as TableDashboardWidgetType)) {
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
    type: type as TableDashboardWidgetType,
    title,
    config,
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

/**
 * Evaluate one widget for the caller: `{widgetId, filterValues?, timezone?,
 * drilldown?: {group, series?}, cursor?}` → `{widget, card, result}`. With
 * `drilldown` the result is the page of records behind that point (same query,
 * filters and scope).
 */
const queryDashboardWidget: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const widgetId = positiveInt(payload, 'widgetId');
  if (!widgetId) return fail('INVALID_INPUT', 'widgetId is required');
  const drilldown = drilldownPoint(payload);
  if (drilldown === null) return fail('INVALID_INPUT', 'drilldown requires a group key');
  if (payload.filterValues !== undefined && !objectValue(payload, 'filterValues')) {
    return fail('INVALID_INPUT', 'filterValues must be an object');
  }
  const base = await baseForWidget(context.db, widgetId);
  const grant = base ? await requireDashboardRead(request, context, base.id, 'dashboardWidget') : undefined;
  if (!grant) return fail('NOT_FOUND', 'Widget not found');
  const widget = await context.db.tables.getDashboardWidget(widgetId);
  if (!widget) return fail('NOT_FOUND', 'Widget not found');
  const custom = grant.access.level === 'custom';

  let card = widgetCardOf(widget);
  if (card.kind === 'text') {
    return ok({ widget, card, result: { kind: 'text', markdown: card.markdown ?? '' } });
  }
  const tableId = card.source?.tableId;
  if (!tableId) return fail('INVALID_INPUT', 'Widget has no table');
  const withheld = () => ok({ widget: widgetForReader(widget, null), card: null, result: { kind: 'no_access' } });
  const data = await requireTableData(request, context, tableId, 'read');
  if (!data) return withheld();
  if (data.scope.kind === 'scoped') {
    const trimmed = trimCardForReader(card, new Set(data.scope.readableFieldIds));
    if (!trimmed) return withheld();
    card = trimmed;
  }

  const dashboard = await context.db.tables.getDashboard(widget.dashboard_id);
  const result = await evaluateTableCard(
    context.db,
    card,
    {
      controls: dashboard ? filterControlsOf(dashboard.dashboard) : [],
      filterValues: objectValue<Record<string, unknown>>(payload, 'filterValues'),
      timezone: viewerTimezone(payload),
      drilldown,
      cursor: stringValue(payload, 'cursor'),
    },
    data.scope,
  );
  return ok({ widget: custom ? widgetForReader(widget, card) : widget, card, result });
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
