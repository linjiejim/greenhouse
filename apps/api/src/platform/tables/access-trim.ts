/**
 * Structure as a custom role sees it — the read-side trimming of spec §1
 * "结构读取". Record data needs none of this (the db enforces the compiled
 * scope on every record call); these helpers cut the *descriptions* of a Base
 * (tables, fields, views, dashboards) down to what the role can read, so a
 * view's filter constant or a widget's hidden column never reaches the client.
 *
 * Every function takes the role's `CustomAccessLens` (`./access.ts`) and is
 * only called for `level === 'custom'`; built-in roles see structure as is.
 */

import { safeJsonParse } from '@greenhouse/utils/json';
import type {
  TableDashboardResult,
  TableDashboardWidgetRow,
  TableFieldRow,
  TableSchemaResult,
  TableViewRow,
} from '@greenhouse/db';
import type {
  TableCardSpec,
  TableDashboardConfig,
  TableDashboardWidgetConfig,
  TableFilterGroup,
  TableQuery,
  TableViewConfig,
} from '@greenhouse/types/tables';
import type { CustomAccessLens } from './access.js';

type Readable = ReadonlySet<number>;
type StoredQuery = Omit<TableQuery, 'cursor' | 'limit'>;

/** Tables the role has a rule for, in the given order. */
export function visibleTables<T extends { id: number }>(lens: CustomAccessLens, tables: readonly T[]): T[] {
  return tables.filter((table) => lens.ruleFor(table.id) !== undefined);
}

/** A field reference is fine when it names a system field or a readable field. */
function refReadable(ref: { fieldId?: number } | undefined, readable: Readable): boolean {
  return ref?.fieldId === undefined || readable.has(ref.fieldId);
}

/** Drop clauses on unreadable fields; an emptied group disappears. Display filters only — row scopes are never trimmed. */
function trimGroup(group: TableFilterGroup | undefined, readable: Readable): TableFilterGroup | undefined {
  if (!group || !Array.isArray(group.clauses)) return undefined;
  const clauses = group.clauses.filter((clause) => refReadable(clause, readable));
  return clauses.length > 0 ? { combinator: group.combinator, clauses } : undefined;
}

function trimQuery(query: StoredQuery | undefined, readable: Readable): StoredQuery | undefined {
  if (!query) return undefined;
  const filters = (query.filters ?? []).flatMap((group) => trimGroup(group, readable) ?? []);
  const sort = (query.sort ?? []).filter((entry) => refReadable(entry, readable));
  return {
    ...(query.search ? { search: query.search } : {}),
    ...(trimGroup(query.where, readable) ? { where: trimGroup(query.where, readable) } : {}),
    ...(filters.length > 0 ? { filters } : {}),
    ...(sort.length > 0 ? { sort } : {}),
    ...(query.groupBy && refReadable(query.groupBy, readable) ? { groupBy: query.groupBy } : {}),
  };
}

/** A saved view's config with every reference to an unreadable field removed. */
export function trimViewConfig(config: TableViewConfig, readable: Readable): TableViewConfig {
  const next: TableViewConfig = { ...config };
  if (config.fieldIds) next.fieldIds = config.fieldIds.filter((id) => readable.has(id));
  if (config.widths) {
    next.widths = Object.fromEntries(
      Object.entries(config.widths).filter(([key]) => !/^\d+$/.test(key) || readable.has(Number(key))),
    );
  }
  if (config.query) next.query = trimQuery(config.query, readable);
  if (config.groupBy && !refReadable(config.groupBy, readable)) delete next.groupBy;
  if (config.kanban) {
    if (!readable.has(config.kanban.groupFieldId)) delete next.kanban;
    else if (config.kanban.coverFieldId !== undefined && !readable.has(config.kanban.coverFieldId)) {
      next.kanban = { ...config.kanban, coverFieldId: undefined };
    }
  }
  if (config.calendar) {
    if (!readable.has(config.calendar.startFieldId)) delete next.calendar;
    else if (config.calendar.endFieldId !== undefined && !readable.has(config.calendar.endFieldId)) {
      next.calendar = { startFieldId: config.calendar.startFieldId };
    }
  }
  if (config.gallery?.coverFieldId !== undefined && !readable.has(config.gallery.coverFieldId)) {
    next.gallery = { ...config.gallery, coverFieldId: undefined };
  }
  return next;
}

export function trimView(lens: CustomAccessLens, view: TableViewRow): TableViewRow {
  const config = safeJsonParse(view.config, {}) as TableViewConfig;
  return { ...view, config: JSON.stringify(trimViewConfig(config, lens.readable(view.table_id))) };
}

export function readableFields(
  lens: CustomAccessLens,
  tableId: number,
  fields: readonly TableFieldRow[],
): TableFieldRow[] {
  const readable = lens.readable(tableId);
  return fields.filter((field) => readable.has(field.id));
}

/** `getSchema` for a custom role: readable fields, trimmed views; undefined when the table is invisible. */
export function trimSchema(lens: CustomAccessLens, schema: TableSchemaResult): TableSchemaResult | undefined {
  if (!lens.ruleFor(schema.table.id)) return undefined;
  return {
    ...schema,
    fields: readableFields(lens, schema.table.id, schema.fields),
    views: schema.views.map((view) => trimView(lens, view)),
  };
}

// ─── Dashboards ───────────────────────────────────────────

function groupFieldIds(group: TableFilterGroup | undefined): number[] {
  return (group?.clauses ?? []).flatMap((clause) => (clause.fieldId === undefined ? [] : [clause.fieldId]));
}

function queryFieldIds(query: StoredQuery | undefined): number[] {
  if (!query) return [];
  return [
    ...groupFieldIds(query.where),
    ...(query.filters ?? []).flatMap(groupFieldIds),
    ...(query.sort ?? []).flatMap((sort) => (sort.fieldId === undefined ? [] : [sort.fieldId])),
    ...(query.groupBy?.fieldId === undefined ? [] : [query.groupBy.fieldId]),
  ];
}

/**
 * The fields a widget's result depends on (predicates, grouping, the measured
 * value) — a widget that needs an unreadable one is not evaluated for the role.
 * Display columns (`card.fieldIds`) are not here: they are trimmed instead.
 */
function widgetDependencies(widget: TableDashboardWidgetRow, config: TableDashboardWidgetConfig) {
  const card: TableCardSpec | undefined = config.card;
  const tableIds = [widget.table_id, card?.source?.tableId].filter((id): id is number => typeof id === 'number');
  const fieldIds = [
    config.valueFieldId,
    config.groupByFieldId,
    ...queryFieldIds(config.query),
    card?.aggregate?.valueFieldId,
    card?.aggregate?.groupBy?.fieldId,
    card?.aggregate?.series?.fieldId,
    ...queryFieldIds(card?.source?.query),
  ].filter((id): id is number => typeof id === 'number');
  return { tableIds, fieldIds };
}

/** Can the role evaluate this widget? Every table it touches needs a rule; every field it depends on, read access. */
export function widgetAccessible(lens: CustomAccessLens, widget: TableDashboardWidgetRow): boolean {
  if (widget.type === 'text' && !widget.table_id) return true;
  const config = safeJsonParse(widget.config, {}) as TableDashboardWidgetConfig;
  const { tableIds, fieldIds } = widgetDependencies(widget, config);
  if (tableIds.length === 0 || tableIds.some((id) => !lens.ruleFor(id))) return false;
  const readable = new Set(tableIds.flatMap((id) => [...lens.readable(id)]));
  return fieldIds.every((id) => readable.has(id));
}

/** A widget as the role gets it: its config with hidden display columns removed, or emptied and flagged `no_access`. */
export function trimWidget(
  lens: CustomAccessLens,
  widget: TableDashboardWidgetRow,
): TableDashboardWidgetRow & { no_access?: true } {
  if (!widgetAccessible(lens, widget)) return { ...widget, config: '{}', no_access: true };
  const config = safeJsonParse(widget.config, {}) as TableDashboardWidgetConfig;
  if (!config.card?.fieldIds || !widget.table_id) return widget;
  const readable = lens.readable(config.card.source?.tableId ?? widget.table_id);
  const card = { ...config.card, fieldIds: config.card.fieldIds.filter((id) => readable.has(id)) };
  return { ...widget, config: JSON.stringify({ ...config, card }) };
}

/** Filter controls lose the targets the role cannot read; a control with none left is removed. */
function trimDashboardConfig(lens: CustomAccessLens, config: TableDashboardConfig): TableDashboardConfig {
  if (!config.filters) return config;
  const filters = config.filters.flatMap((control) => {
    const targets = control.targets.filter(
      (target) => lens.ruleFor(target.tableId) && refReadable(target, lens.readable(target.tableId)),
    );
    return targets.length > 0 ? [{ ...control, targets }] : [];
  });
  return { ...config, filters };
}

/** `getDashboard` for a custom role (the caller already refused `dashboards: 'none'`). */
export function trimDashboard(lens: CustomAccessLens, result: TableDashboardResult): TableDashboardResult {
  return {
    dashboard: { ...result.dashboard, config: trimDashboardConfig(lens, result.dashboard.config) },
    widgets: result.widgets.map((widget) => trimWidget(lens, widget)),
  };
}
