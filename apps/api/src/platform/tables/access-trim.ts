/**
 * Structure as a custom role sees it — the read-side trimming of spec §1
 * "结构读取". Record data needs none of this (the db enforces the compiled
 * scope on every record call); these helpers cut the *descriptions* of a Base
 * (tables, fields, views) down to what the role can read, so a view's filter
 * constant never reaches the client. Dashboards are trimmed by the card helpers
 * (`trimCardForReader` / `trimFilterControlsForReader`, slice D).
 *
 * Every function takes the role's `CustomAccessLens` (`./access.ts`) and is
 * only called for `level === 'custom'`; built-in roles see structure as is.
 */

import { safeJsonParse } from '@greenhouse/utils/json';
import type { TableFieldRow, TableSchemaResult, TableViewRow } from '@greenhouse/db';
import type { TableFilterGroup, TableQuery, TableViewConfig } from '@greenhouse/types/tables';
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
