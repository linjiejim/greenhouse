/**
 * Saved views (shared and personal) and the one validator of their config.
 *
 * `normalizeViewConfig(type, config, schema)` checks every key against the
 * table's schema as the author sees it (a scoped author: its readable fields
 * only) and rebuilds the config from known keys, so whatever reaches the row
 * is a well-formed `TableViewConfig`:
 *
 * - display lists (`fieldIds`, `systemFields`, `widths`, kanban `hiddenGroups`)
 *   drop ids that no longer resolve — a field archived since the view was
 *   saved must not make the view unsaveable;
 * - the keys that make the view's own type work (`kanban.groupFieldId`,
 *   `calendar.startFieldId`, …) are required and must reference a field of the
 *   right type, otherwise the write is refused;
 * - the other types' keys are kept only when still valid, so switching a view
 *   kanban → grid → kanban keeps its lanes;
 * - the saved query is dry-compiled by the one SQL compiler (`./query.ts`), so
 *   a stored filter has exactly the meaning the record query will give it.
 */

import { and, asc, eq, max, or } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { safeJsonParse } from '@greenhouse/utils/json';
import {
  TABLE_SYSTEM_FIELDS,
  TABLE_VIEW_NO_VALUE_GROUP,
  TABLE_VIEW_ROW_HEIGHTS,
  TABLE_VIEW_TYPES,
} from '@greenhouse/types/tables';
import type {
  TableFieldType,
  TableFilterClause,
  TableFilterGroup,
  TableGroupBy,
  TableSort,
  TableSystemField,
  TableViewConfig,
  TableViewScope,
  TableViewType,
} from '@greenhouse/types/tables';
import { fullTableAccess, type TableAccessScope } from '@greenhouse/types/table-access';
import type { Db } from '../../client.js';
import { tableViews } from '../../schema/index.js';
import type { TableFieldRow, TableViewRow } from '../../schema/tables.js';
import { compileRecordQuery, loadCompileContext, type TableCompileContext } from './query.js';
import {
  assertScope,
  isPlainObject,
  isPositiveInteger,
  MAX_FIELDS,
  parseTableFieldConfig,
  TablesValidationError,
  trimmed,
  type TableRevisionResult,
} from './shared.js';

export interface UpdateTableViewInput {
  revision: number;
  name?: string;
  /** Change the view's type; its config is re-validated for the new type. */
  type?: TableViewType;
  config?: TableViewConfig;
  position?: number;
}

export interface CreateTableViewInput {
  table_id: number;
  name: string;
  type?: TableViewType;
  scope?: TableViewScope;
  owner_id?: string | null;
  config?: TableViewConfig;
  /** Default: after the table's last view. */
  position?: number;
  created_by: string;
}

// ─── Config rules ─────────────────────────────────────────

const MAX_FROZEN_COLUMNS = 10;
const MAX_HIDDEN_GROUPS = 200;
const MAX_GROUP_KEY_LENGTH = 200;
const MIN_COLUMN_WIDTH = 40;
const MAX_COLUMN_WIDTH = 1600;

/** Grid grouping keys: one value per record, comparable as text. */
const GROUPABLE_FIELD_TYPES: ReadonlySet<TableFieldType> = new Set([
  'text',
  'number',
  'boolean',
  'date',
  'datetime',
  'single_select',
  'user',
  'url',
  'email',
  'phone',
  'formula',
  'rollup',
]);
/** Kanban lanes: the options of a single select, or the people of a person field. */
const KANBAN_GROUP_FIELD_TYPES: ReadonlySet<TableFieldType> = new Set(['single_select', 'user']);
/** Calendar placement: a stored date / datetime (dragging a record rewrites it). */
const CALENDAR_FIELD_TYPES: ReadonlySet<TableFieldType> = new Set(['date', 'datetime']);
const COVER_FIELD_TYPES: ReadonlySet<TableFieldType> = new Set(['attachment']);

export function isTableViewType(value: unknown): value is TableViewType {
  return typeof value === 'string' && (TABLE_VIEW_TYPES as readonly string[]).includes(value);
}

function isSystemField(value: unknown): value is TableSystemField {
  return typeof value === 'string' && (TABLE_SYSTEM_FIELDS as readonly string[]).includes(value);
}

function invalid(message: string): TablesValidationError {
  return new TablesValidationError(message);
}

/** Fields the author may reference: active, and readable for a scoped author. */
function referenceable(ctx: TableCompileContext, fieldId: unknown): TableFieldRow | undefined {
  if (!isPositiveInteger(fieldId)) return undefined;
  const field = ctx.byId.get(fieldId);
  if (!field || (ctx.readable && !ctx.readable.has(field.id))) return undefined;
  return field;
}

/**
 * A structural reference (grouping, lanes, dates, cover). Missing, unreadable
 * and wrong-type fields get the same message — no existence oracle.
 */
function structuralField(
  ctx: TableCompileContext,
  fieldId: unknown,
  types: ReadonlySet<TableFieldType>,
  label: string,
): TableFieldRow {
  const field = referenceable(ctx, fieldId);
  if (!field || !types.has(field.type)) {
    throw invalid(`${label} must be a ${[...types].join(' / ')} field of this table`);
  }
  return field;
}

/** Run `build` for another type's keys: kept when still valid, dropped otherwise. */
function lenient<T>(build: () => T | undefined): T | undefined {
  try {
    return build();
  } catch (error) {
    if (error instanceof TablesValidationError) return undefined;
    throw error;
  }
}

function normalizeFieldIds(raw: unknown, ctx: TableCompileContext): number[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw invalid('fieldIds must be an array of field ids');
  const ids: number[] = [];
  for (const id of raw) {
    if (!isPositiveInteger(id)) throw invalid('fieldIds must be an array of field ids');
    if (referenceable(ctx, id) && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, MAX_FIELDS);
}

function normalizeSystemFields(raw: unknown): TableSystemField[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every(isSystemField)) {
    throw invalid(`systemFields must list ${TABLE_SYSTEM_FIELDS.join(' / ')}`);
  }
  return [...new Set(raw)];
}

function normalizeWidths(raw: unknown, ctx: TableCompileContext): Record<string, number> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw invalid('widths must map columns to pixel widths');
  const widths: Record<string, number> = {};
  for (const [key, width] of Object.entries(raw)) {
    if (typeof width !== 'number' || !Number.isFinite(width)) throw invalid('widths must map columns to pixel widths');
    const known = isSystemField(key) || referenceable(ctx, Number(key)) !== undefined;
    if (!known) continue;
    widths[key] = Math.round(Math.min(Math.max(width, MIN_COLUMN_WIDTH), MAX_COLUMN_WIDTH));
  }
  return Object.keys(widths).length > 0 ? widths : undefined;
}

function normalizeFrozenCount(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_FROZEN_COLUMNS) {
    throw invalid(`frozenCount must be a whole number from 0 to ${MAX_FROZEN_COLUMNS}`);
  }
  return raw;
}

function normalizeDirection(raw: unknown, label: string): 'asc' | 'desc' | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'asc' && raw !== 'desc') throw invalid(`${label} direction must be asc or desc`);
  return raw;
}

/** Grid grouping: one groupable field, or a system field. */
function normalizeGroupBy(raw: unknown, ctx: TableCompileContext): TableGroupBy {
  if (!isPlainObject(raw) || (raw.fieldId === undefined) === (raw.systemField === undefined)) {
    throw invalid('groupBy requires exactly one of fieldId / systemField');
  }
  const direction = normalizeDirection(raw.direction, 'groupBy');
  if (raw.systemField !== undefined) {
    if (!isSystemField(raw.systemField)) throw invalid('groupBy systemField is invalid');
    return { systemField: raw.systemField, ...(direction ? { direction } : {}) };
  }
  const field = structuralField(ctx, raw.fieldId, GROUPABLE_FIELD_TYPES, 'groupBy');
  return { fieldId: field.id, ...(direction ? { direction } : {}) };
}

function normalizeHiddenGroups(raw: unknown, groupField: TableFieldRow): string[] | undefined {
  if (raw === undefined) return undefined;
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_HIDDEN_GROUPS ||
    !raw.every((key) => typeof key === 'string' && key.length <= MAX_GROUP_KEY_LENGTH)
  ) {
    throw invalid(`kanban.hiddenGroups must be at most ${MAX_HIDDEN_GROUPS} lane keys`);
  }
  // A select lane is an option id; drop options deleted since.
  const options =
    groupField.type === 'single_select'
      ? new Set((parseTableFieldConfig(groupField).options ?? []).map((option) => option.id))
      : null;
  const keys = [...new Set(raw as string[])].filter(
    (key) => key === TABLE_VIEW_NO_VALUE_GROUP || !options || options.has(key),
  );
  return keys.length > 0 ? keys : undefined;
}

function normalizeKanban(raw: unknown, ctx: TableCompileContext): NonNullable<TableViewConfig['kanban']> {
  if (!isPlainObject(raw)) throw invalid('A kanban view needs a single-select or person field for its lanes');
  const group = structuralField(ctx, raw.groupFieldId, KANBAN_GROUP_FIELD_TYPES, 'kanban.groupFieldId');
  const kanban: NonNullable<TableViewConfig['kanban']> = { groupFieldId: group.id };
  if (raw.coverFieldId !== undefined && raw.coverFieldId !== null) {
    kanban.coverFieldId = structuralField(ctx, raw.coverFieldId, COVER_FIELD_TYPES, 'kanban.coverFieldId').id;
  }
  const hidden = normalizeHiddenGroups(raw.hiddenGroups, group);
  if (hidden) kanban.hiddenGroups = hidden;
  return kanban;
}

function normalizeCalendar(raw: unknown, ctx: TableCompileContext): NonNullable<TableViewConfig['calendar']> {
  if (!isPlainObject(raw)) throw invalid('A calendar view needs a date field to place records on');
  const start = structuralField(ctx, raw.startFieldId, CALENDAR_FIELD_TYPES, 'calendar.startFieldId');
  const calendar: NonNullable<TableViewConfig['calendar']> = { startFieldId: start.id };
  if (raw.endFieldId !== undefined && raw.endFieldId !== null) {
    const end = structuralField(ctx, raw.endFieldId, CALENDAR_FIELD_TYPES, 'calendar.endFieldId');
    if (end.id === start.id) throw invalid('calendar.endFieldId must differ from startFieldId');
    calendar.endFieldId = end.id;
  }
  return calendar;
}

function normalizeGallery(raw: unknown, ctx: TableCompileContext): NonNullable<TableViewConfig['gallery']> {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw invalid('gallery must be an object');
  const gallery: NonNullable<TableViewConfig['gallery']> = {};
  if (raw.coverFieldId !== undefined && raw.coverFieldId !== null) {
    gallery.coverFieldId = structuralField(ctx, raw.coverFieldId, COVER_FIELD_TYPES, 'gallery.coverFieldId').id;
  }
  if (raw.fit !== undefined) {
    if (raw.fit !== 'cover' && raw.fit !== 'contain') throw invalid('gallery.fit must be cover or contain');
    gallery.fit = raw.fit;
  }
  return gallery;
}

function normalizeRowHeight(raw: unknown): TableViewConfig['rowHeight'] {
  if (raw === undefined) return undefined;
  if (!(TABLE_VIEW_ROW_HEIGHTS as readonly unknown[]).includes(raw)) {
    throw invalid(`rowHeight must be ${TABLE_VIEW_ROW_HEIGHTS.join(' / ')}`);
  }
  return raw as TableViewConfig['rowHeight'];
}

/** A clause with only its known keys (the compiler checks the rest). */
function cleanClause(clause: unknown): TableFilterClause {
  if (!isPlainObject(clause)) throw invalid('Each filter clause must be an object');
  const value = clause.value === undefined ? {} : { value: clause.value };
  return clause.systemField !== undefined
    ? ({ systemField: clause.systemField, operator: clause.operator, ...value } as TableFilterClause)
    : ({ fieldId: clause.fieldId, operator: clause.operator, ...value } as TableFilterClause);
}

function cleanGroup(group: unknown, label: string): TableFilterGroup {
  if (!isPlainObject(group) || !Array.isArray(group.clauses)) {
    throw invalid(`${label} must contain an and/or combinator and clauses array`);
  }
  return { combinator: group.combinator as TableFilterGroup['combinator'], clauses: group.clauses.map(cleanClause) };
}

function cleanSort(sort: unknown): TableSort {
  if (!isPlainObject(sort)) throw invalid('Each sort requires one valid field and asc/desc direction');
  const direction = sort.direction as TableSort['direction'];
  return sort.systemField !== undefined
    ? { systemField: sort.systemField as TableSystemField, direction }
    : { fieldId: sort.fieldId as number, direction };
}

type SavedQuery = NonNullable<TableViewConfig['query']>;

/**
 * The saved query, rebuilt from known keys and dry-compiled: an unknown or
 * unreadable field, a wrong operator or value fails here exactly as the record
 * query would. Grouping lives in `config.groupBy`, never in the query.
 */
function normalizeQuery(raw: unknown, ctx: TableCompileContext): SavedQuery | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) throw invalid('query must be an object');
  const query: SavedQuery = {};
  if (raw.where !== undefined && raw.where !== null) {
    const where = cleanGroup(raw.where, 'where');
    if (where.clauses.length > 0) query.where = where;
  }
  if (raw.filters !== undefined) {
    if (!Array.isArray(raw.filters)) throw invalid('filters must be an array of filter groups');
    const filters = raw.filters
      .map((group) => cleanGroup(group, 'Each filter group'))
      .filter((group) => group.clauses.length > 0);
    if (filters.length > 0) query.filters = filters;
  }
  if (raw.search !== undefined && raw.search !== '') {
    if (typeof raw.search !== 'string') throw invalid('search must be text');
    query.search = raw.search;
  }
  if (raw.sort !== undefined) {
    if (!Array.isArray(raw.sort)) throw invalid('sort must be an array');
    if (raw.sort.length > 0) query.sort = raw.sort.map(cleanSort);
  }
  compileRecordQuery({ ...query, limit: 1 }, fullTableAccess(ctx.userId), ctx);
  return Object.keys(query).length > 0 ? query : undefined;
}

/**
 * Validate and rebuild a view's config for `type` against the schema as the
 * author sees it (`schema.readable` limits a scoped author to its readable
 * fields). Throws `TablesValidationError` for a malformed key or for a missing
 * / unusable key the type needs; unknown keys are dropped.
 */
export function normalizeViewConfig(type: TableViewType, raw: unknown, schema: TableCompileContext): TableViewConfig {
  if (!isTableViewType(type)) throw invalid(`View type must be ${TABLE_VIEW_TYPES.join(' / ')}`);
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) throw invalid('View config must be an object');
  const input: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  const config: TableViewConfig = { version: 1 };

  const fieldIds = normalizeFieldIds(input.fieldIds, schema);
  if (fieldIds) config.fieldIds = fieldIds;
  const systemFields = normalizeSystemFields(input.systemFields);
  if (systemFields) config.systemFields = systemFields;
  const widths = normalizeWidths(input.widths, schema);
  if (widths) config.widths = widths;
  const frozenCount = normalizeFrozenCount(input.frozenCount);
  if (frozenCount !== undefined) config.frozenCount = frozenCount;
  const rowHeight = normalizeRowHeight(input.rowHeight);
  if (rowHeight) config.rowHeight = rowHeight;

  const query = normalizeQuery(input.query, schema);
  if (query) config.query = query;

  // A grouping written into the query (an older client, an Agent plan) moves
  // to the one place grids read it from.
  const queryGroupBy = isPlainObject(input.query) ? input.query.groupBy : undefined;
  const rawGroupBy = input.groupBy ?? queryGroupBy;
  if (rawGroupBy !== undefined && rawGroupBy !== null) {
    const groupBy =
      type === 'grid' ? normalizeGroupBy(rawGroupBy, schema) : lenient(() => normalizeGroupBy(rawGroupBy, schema));
    if (groupBy) config.groupBy = groupBy;
  }

  const kanban =
    type === 'kanban'
      ? normalizeKanban(input.kanban, schema)
      : input.kanban === undefined
        ? undefined
        : lenient(() => normalizeKanban(input.kanban, schema));
  if (kanban) config.kanban = kanban;

  const calendar =
    type === 'calendar'
      ? normalizeCalendar(input.calendar, schema)
      : input.calendar === undefined
        ? undefined
        : lenient(() => normalizeCalendar(input.calendar, schema));
  if (calendar) config.calendar = calendar;

  const gallery =
    type === 'gallery'
      ? normalizeGallery(input.gallery, schema)
      : lenient(() => normalizeGallery(input.gallery, schema));
  if (gallery && Object.keys(gallery).length > 0) config.gallery = gallery;

  return config;
}

function viewTypeOf(value: unknown): TableViewType {
  if (value === undefined) return 'grid';
  if (!isTableViewType(value)) throw invalid(`View type must be ${TABLE_VIEW_TYPES.join(' / ')}`);
  return value;
}

// ─── Service ──────────────────────────────────────────────

export function createTablesViews(db: Db) {
  const visibleTo = (userId: string | undefined) =>
    userId ? or(eq(tableViews.scope, 'shared'), eq(tableViews.owner_id, userId)) : eq(tableViews.scope, 'shared');

  const service = {
    async listViews(tableId: number, userId?: string): Promise<TableViewRow[]> {
      return db
        .select()
        .from(tableViews)
        .where(and(eq(tableViews.table_id, tableId), visibleTo(userId)))
        .orderBy(asc(tableViews.position), asc(tableViews.id));
    },

    async getView(id: number, userId?: string): Promise<TableViewRow | undefined> {
      const visibility = userId ? visibleTo(userId) : undefined;
      const rows = await db
        .select()
        .from(tableViews)
        .where(visibility ? and(eq(tableViews.id, id), visibility) : eq(tableViews.id, id))
        .limit(1);
      return rows[0];
    },

    /**
     * `scope` is the author's view of the table: config references are checked
     * against the fields it may read (built-in roles pass full access).
     */
    async createView(input: CreateTableViewInput, scope: TableAccessScope): Promise<TableViewRow> {
      assertScope(scope);
      if (input.scope === 'personal' && !input.owner_id) {
        throw new TablesValidationError('Personal views require owner_id');
      }
      const type = viewTypeOf(input.type);
      const name = trimmed(input.name, 'View name', 120);
      const ctx = await loadCompileContext(db, input.table_id, scope);
      const config = normalizeViewConfig(type, input.config ?? {}, ctx);
      let position = input.position;
      if (position === undefined) {
        const [last] = await db
          .select({ position: max(tableViews.position) })
          .from(tableViews)
          .where(eq(tableViews.table_id, input.table_id));
        position = last?.position === null || last?.position === undefined ? 0 : last.position + 1;
      }
      const now = nowIso();
      const [row] = await db
        .insert(tableViews)
        .values({
          table_id: input.table_id,
          name,
          type,
          scope: input.scope ?? 'shared',
          owner_id: input.scope === 'personal' ? input.owner_id : null,
          config: JSON.stringify(config),
          position,
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    /** Revision-checked; changing `type` or `config` re-validates the config for the (new) type. */
    async updateView(
      id: number,
      patch: UpdateTableViewInput,
      userId: string | undefined,
      scope: TableAccessScope,
    ): Promise<TableRevisionResult<TableViewRow>> {
      assertScope(scope);
      const current = await service.getView(id, userId);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.revision !== patch.revision) {
        return { ok: false, reason: 'conflict', current: current.revision };
      }
      const values: Partial<TableViewRow> = {
        revision: patch.revision + 1,
        updated_at: nowIso(),
      };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'View name', 120);
      if (patch.type !== undefined || patch.config !== undefined) {
        const type = patch.type === undefined ? current.type : viewTypeOf(patch.type);
        const config: unknown = patch.config ?? safeJsonParse(current.config, {});
        const ctx = await loadCompileContext(db, current.table_id, scope);
        values.type = type;
        values.config = JSON.stringify(normalizeViewConfig(type, config, ctx));
      }
      if (patch.position !== undefined) values.position = patch.position;
      const rows = await db
        .update(tableViews)
        .set(values)
        .where(and(eq(tableViews.id, id), eq(tableViews.revision, patch.revision)))
        .returning();
      if (rows[0]) return { ok: true, value: rows[0] };
      const latest = await service.getView(id, userId);
      return latest ? { ok: false, reason: 'conflict', current: latest.revision } : { ok: false, reason: 'not_found' };
    },

    /**
     * Hard delete: a view is configuration only, no data hangs off it. A
     * personal view of someone else is invisible here, exactly like `getView`.
     */
    async deleteView(id: number, userId?: string): Promise<TableViewRow | undefined> {
      const visibility = userId ? visibleTo(userId) : undefined;
      const rows = await db
        .delete(tableViews)
        .where(visibility ? and(eq(tableViews.id, id), visibility) : eq(tableViews.id, id))
        .returning();
      return rows[0];
    },
  };
  return service;
}
