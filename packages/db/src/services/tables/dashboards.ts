/**
 * Dashboards and widgets — configuration only. Evaluation goes through the
 * scoped record query / aggregate paths (the API's `platform/tables/cards.ts`).
 *
 * - A widget's `config` is `{version: 2, card: TableCardSpec}` — the one card
 *   shape shared with Phase 1 app cards. Legacy flat configs (`operation /
 *   valueFieldId / groupByFieldId / query / limit / text`) are still accepted on
 *   write and mapped onto a card (`legacyWidgetToCard`); stored legacy rows are
 *   mapped the same way when read. The `type` column always mirrors the card
 *   (`widgetTypeForCard`), and `table_id` always equals `card.source.tableId`.
 * - A dashboard's `config` is `{version: 1, filters: TableFilterControl[]}`.
 * - Both are checked against the schema on write: tables in the dashboard's
 *   Base, active fields, a type each use can work with, and a card query that
 *   the compiler accepts. Readability per viewer is the evaluator's job.
 */

import { and, asc, eq } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { safeJsonParse } from '@greenhouse/utils/json';
import { TABLE_DASHBOARD_WIDGET_TYPES } from '@greenhouse/types/tables';
import type {
  TableCardSpec,
  TableDashboardConfig,
  TableDashboardWidgetConfig,
  TableDashboardWidgetLayout,
  TableDashboardWidgetType,
  TableFieldType,
  TableFilterControl,
} from '@greenhouse/types/tables';
import {
  legacyWidgetToCard,
  normalizeDashboardConfig,
  normalizeTableCardSpec,
  widgetTypeForCard,
} from '@greenhouse/types/table-cards';
import { fullTableAccess } from '@greenhouse/types/table-access';
import type { Db } from '../../client.js';
import { tableDashboardWidgets, tableDashboards } from '../../schema/index.js';
import type { TableDashboardRow, TableDashboardWidgetRow, TableFieldRow } from '../../schema/tables.js';
import { compileRecordQuery, queryValueField } from './query.js';
import { dbSchemaSource, sourceCompileContext, type TablesSchemaSource } from './schema-source.js';
import { TablesValidationError, trimmed, type TableRevisionResult } from './shared.js';

export interface CreateTableDashboardInput {
  base_id: number;
  name: string;
  description?: string | null;
  config?: TableDashboardConfig;
  created_by: string;
}

export interface CreateTableDashboardWidgetInput {
  dashboard_id: number;
  table_id?: number | null;
  /** Legacy flat configs need it; with `config.card` the card decides the stored type. */
  type: TableDashboardWidgetType;
  title: string;
  config?: TableDashboardWidgetConfig;
  layout?: TableDashboardWidgetLayout;
  position?: number;
  created_by: string;
}

export interface UpdateTableDashboardInput {
  revision: number;
  name?: string;
  description?: string | null;
  config?: TableDashboardConfig;
}

export interface UpdateTableDashboardWidgetInput {
  revision: number;
  table_id?: number | null;
  title?: string;
  config?: TableDashboardWidgetConfig;
  layout?: TableDashboardWidgetLayout;
  position?: number;
}

export interface TableDashboardResult {
  dashboard: TableDashboardRow;
  widgets: TableDashboardWidgetRow[];
}

/** The card a stored widget row describes (legacy rows mapped on the fly). */
export function widgetCard(widget: Pick<TableDashboardWidgetRow, 'type' | 'config' | 'table_id'>): TableCardSpec {
  return legacyWidgetToCard(
    widget.type,
    safeJsonParse(widget.config, {}) as TableDashboardWidgetConfig,
    widget.table_id,
  );
}

function normalizeWidgetLayout(input?: TableDashboardWidgetLayout): TableDashboardWidgetLayout {
  const layout = input ?? { version: 1, x: 0, y: 0, w: 6, h: 4 };
  if (
    !layout ||
    typeof layout !== 'object' ||
    ![layout.x, layout.y, layout.w, layout.h].every((value) => Number.isInteger(value)) ||
    layout.x < 0 ||
    layout.y < 0 ||
    layout.w < 1 ||
    layout.h < 1 ||
    layout.w > 24 ||
    layout.h > 24
  ) {
    throw new TablesValidationError('Widget layout requires integer x/y >= 0 and w/h between 1 and 24');
  }
  return { ...layout, version: 1 };
}

const DATE_TYPES: ReadonlySet<TableFieldType> = new Set(['date', 'datetime']);
const SELECT_TYPES: ReadonlySet<TableFieldType> = new Set(['single_select', 'multi_select']);
const USER_TYPES: ReadonlySet<TableFieldType> = new Set(['user', 'multi_user']);
const SEARCH_TYPES: ReadonlySet<TableFieldType> = new Set(['text', 'long_text', 'url', 'email', 'phone']);
const CONTROL_FIELD_TYPES: Readonly<Record<TableFilterControl['kind'], ReadonlySet<TableFieldType>>> = {
  date_range: DATE_TYPES,
  select: SELECT_TYPES,
  user: USER_TYPES,
  search: SEARCH_TYPES,
};

/** An active table of this Base, per the source. */
async function tableInBase(source: TablesSchemaSource, tableId: number, baseId: number): Promise<boolean> {
  const table = await source.table(tableId);
  return Boolean(table && table.base_id === baseId && !table.archived);
}

/** Schema checks for one card: table in the Base, live fields of usable types, a query the compiler accepts. */
async function validateCard(source: TablesSchemaSource, card: TableCardSpec, baseId: number): Promise<void> {
  if (card.kind === 'text') return;
  const tableId = card.source?.tableId;
  if (!tableId || !(await tableInBase(source, tableId, baseId))) {
    throw new TablesValidationError('Widget table must belong to this Base');
  }
  // Compile the card's own query as an unrestricted reader: unknown fields,
  // operators and values fail here instead of on every viewer's dashboard.
  const ctx = await sourceCompileContext(source, tableId, fullTableAccess(null));
  compileRecordQuery({ ...(card.source?.query ?? {}), limit: 1 }, fullTableAccess(null), ctx);
  const field = (fieldId: number | undefined, label: string): TableFieldRow => {
    const found = fieldId === undefined ? undefined : ctx.byId.get(fieldId);
    if (!found) throw new TablesValidationError(`${label} field ${fieldId ?? ''} is unavailable`.trim());
    return found;
  };
  const aggregate = card.aggregate;
  if (aggregate) {
    if (aggregate.operation !== 'count' && queryValueField(field(aggregate.valueFieldId, 'Value')).type !== 'number') {
      throw new TablesValidationError(`${aggregate.operation} requires a numeric value field`);
    }
    if (aggregate.groupBy?.fieldId !== undefined) {
      const groupField = field(aggregate.groupBy.fieldId, 'Group');
      if (aggregate.groupBy.dateBucket && !DATE_TYPES.has(queryValueField(groupField).type)) {
        throw new TablesValidationError('A date bucket requires a date or datetime field');
      }
    }
    if (aggregate.series?.fieldId !== undefined) field(aggregate.series.fieldId, 'Series');
  }
  for (const fieldId of card.fieldIds ?? []) field(fieldId, 'Column');
}

/**
 * The card a widget write stores, its type and table: normalized, consistent,
 * and checked against the schema the source describes (tables of `baseId`).
 */
export async function checkWidgetCard(
  source: TablesSchemaSource,
  baseId: number,
  type: TableDashboardWidgetType,
  config: TableDashboardWidgetConfig | undefined,
  tableId: number | null | undefined,
): Promise<{ type: TableDashboardWidgetType; tableId: number | null; card: TableCardSpec }> {
  if (!TABLE_DASHBOARD_WIDGET_TYPES.includes(type)) {
    throw new TablesValidationError(`Unsupported dashboard widget type "${type}"`);
  }
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) {
    throw new TablesValidationError('Widget config must be an object');
  }
  const raw = config?.card ?? legacyWidgetToCard(type, config ?? {}, tableId);
  // A table given beside a sourceless card is the card's source.
  const withSource =
    raw.kind !== 'text' && !raw.source && tableId ? { ...raw, source: { tableId } } : (raw as TableCardSpec);
  const normalized = normalizeTableCardSpec(withSource);
  if (!normalized.ok) throw new TablesValidationError(normalized.error);
  const card = normalized.card;
  const sourceTable = card.source?.tableId ?? null;
  if (card.kind !== 'text' && tableId && sourceTable !== tableId) {
    throw new TablesValidationError('Widget table does not match its card source');
  }
  await validateCard(source, card, baseId);
  return { type: widgetTypeForCard(card), tableId: sourceTable, card };
}

/** Shape + schema checks for a dashboard's filter controls (targets on tables of `baseId`). */
export async function checkDashboardConfig(
  source: TablesSchemaSource,
  baseId: number,
  config: unknown,
): Promise<Required<TableDashboardConfig>> {
  const normalized = normalizeDashboardConfig(config);
  if (!normalized.ok) throw new TablesValidationError(normalized.error);
  const controls = normalized.config.filters;
  const tableIds = [...new Set(controls.flatMap((control) => control.targets.map((target) => target.tableId)))];
  const fields = new Map<number, TableFieldRow>();
  for (const tableId of tableIds) {
    if (!(await tableInBase(source, tableId, baseId))) {
      throw new TablesValidationError('Filter targets must be tables of this Base');
    }
    for (const field of await source.fields(tableId)) fields.set(field.id, field);
  }
  for (const control of controls) {
    for (const target of control.targets) {
      if (target.fieldId === undefined) continue;
      const field = fields.get(target.fieldId);
      if (!field || field.table_id !== target.tableId) {
        throw new TablesValidationError(`Filter "${control.label}" targets an unavailable field`);
      }
      if (!CONTROL_FIELD_TYPES[control.kind].has(queryValueField(field).type)) {
        throw new TablesValidationError(`Filter "${control.label}" cannot filter field "${field.name}"`);
      }
    }
  }
  return normalized.config;
}

export function createTablesDashboards(db: Db) {
  async function dashboardBaseId(dashboardId: number): Promise<number> {
    const rows = await db
      .select({ base_id: tableDashboards.base_id })
      .from(tableDashboards)
      .where(eq(tableDashboards.id, dashboardId))
      .limit(1);
    if (!rows[0]) throw new TablesValidationError('Dashboard not found');
    return rows[0].base_id;
  }

  /** The stored form of a widget write. */
  async function prepareWidget(
    type: TableDashboardWidgetType,
    config: TableDashboardWidgetConfig | undefined,
    tableId: number | null | undefined,
    baseId: number,
  ): Promise<{ type: TableDashboardWidgetType; tableId: number | null; config: string }> {
    const checked = await checkWidgetCard(dbSchemaSource(db), baseId, type, config, tableId);
    return { type: checked.type, tableId: checked.tableId, config: JSON.stringify({ version: 2, card: checked.card }) };
  }

  const prepareDashboardConfig = (config: unknown, baseId: number) =>
    checkDashboardConfig(dbSchemaSource(db), baseId, config);

  const service = {
    async createDashboard(input: CreateTableDashboardInput): Promise<TableDashboardRow> {
      const config = await prepareDashboardConfig(input.config, input.base_id);
      const now = nowIso();
      const [row] = await db
        .insert(tableDashboards)
        .values({
          base_id: input.base_id,
          name: trimmed(input.name, 'Dashboard name', 120),
          description: input.description?.trim() || null,
          config,
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async listDashboards(baseId: number): Promise<TableDashboardRow[]> {
      return db
        .select()
        .from(tableDashboards)
        .where(eq(tableDashboards.base_id, baseId))
        .orderBy(asc(tableDashboards.id));
    },

    async getDashboard(id: number): Promise<TableDashboardResult | undefined> {
      const rows = await db.select().from(tableDashboards).where(eq(tableDashboards.id, id)).limit(1);
      if (!rows[0]) return undefined;
      const widgets = await db
        .select()
        .from(tableDashboardWidgets)
        .where(eq(tableDashboardWidgets.dashboard_id, id))
        .orderBy(asc(tableDashboardWidgets.position), asc(tableDashboardWidgets.id));
      return { dashboard: rows[0], widgets };
    },

    async updateDashboard(
      id: number,
      patch: UpdateTableDashboardInput,
    ): Promise<TableRevisionResult<TableDashboardRow>> {
      const current = await db.select().from(tableDashboards).where(eq(tableDashboards.id, id)).limit(1);
      if (!current[0]) return { ok: false, reason: 'not_found' };
      if (current[0].revision !== patch.revision) {
        return { ok: false, reason: 'conflict', current: current[0].revision };
      }
      const values: Partial<TableDashboardRow> = {
        revision: patch.revision + 1,
        updated_at: nowIso(),
      };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'Dashboard name', 120);
      if (patch.description !== undefined) values.description = patch.description?.trim() || null;
      if (patch.config !== undefined) values.config = await prepareDashboardConfig(patch.config, current[0].base_id);
      const rows = await db
        .update(tableDashboards)
        .set(values)
        .where(and(eq(tableDashboards.id, id), eq(tableDashboards.revision, patch.revision)))
        .returning();
      if (rows[0]) return { ok: true, value: rows[0] };
      const latest = await db.select().from(tableDashboards).where(eq(tableDashboards.id, id)).limit(1);
      return latest[0]
        ? { ok: false, reason: 'conflict', current: latest[0].revision }
        : { ok: false, reason: 'not_found' };
    },

    /**
     * Dashboards are pure configuration — widgets cascade and no business data
     * lives here — so this is a real delete rather than the archive used for
     * bases, tables and records (spec D4).
     */
    async deleteDashboard(id: number): Promise<boolean> {
      const rows = await db.delete(tableDashboards).where(eq(tableDashboards.id, id)).returning();
      return rows.length > 0;
    },

    async getDashboardWidget(id: number): Promise<TableDashboardWidgetRow | undefined> {
      const rows = await db.select().from(tableDashboardWidgets).where(eq(tableDashboardWidgets.id, id)).limit(1);
      return rows[0];
    },

    async createDashboardWidget(input: CreateTableDashboardWidgetInput): Promise<TableDashboardWidgetRow> {
      const baseId = await dashboardBaseId(input.dashboard_id);
      if (input.type !== 'text' && !input.table_id && !input.config?.card) {
        throw new TablesValidationError(`${input.type} widgets require table_id`);
      }
      const prepared = await prepareWidget(input.type, input.config, input.table_id, baseId);
      const layout = normalizeWidgetLayout(input.layout);
      const now = nowIso();
      const [row] = await db
        .insert(tableDashboardWidgets)
        .values({
          dashboard_id: input.dashboard_id,
          table_id: prepared.tableId,
          type: prepared.type,
          title: trimmed(input.title, 'Widget title', 120),
          config: prepared.config,
          layout: JSON.stringify(layout),
          position: input.position ?? 0,
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        })
        .returning();
      return row!;
    },

    async updateDashboardWidget(
      id: number,
      patch: UpdateTableDashboardWidgetInput,
    ): Promise<TableRevisionResult<TableDashboardWidgetRow>> {
      const current = await service.getDashboardWidget(id);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.revision !== patch.revision) {
        return { ok: false, reason: 'conflict', current: current.revision };
      }
      const values: Partial<TableDashboardWidgetRow> = {
        revision: patch.revision + 1,
        updated_at: nowIso(),
      };
      if (patch.config !== undefined || patch.table_id !== undefined) {
        const baseId = await dashboardBaseId(current.dashboard_id);
        const tableId = patch.table_id === undefined ? current.table_id : patch.table_id;
        // Moving a widget to another table without a new config re-points its card.
        const existing = widgetCard(current);
        const config: TableDashboardWidgetConfig =
          patch.config ??
          (existing.kind !== 'text' && tableId
            ? { card: { ...existing, source: { ...existing.source, tableId } } }
            : { card: existing });
        const prepared = await prepareWidget(current.type, config, tableId, baseId);
        values.type = prepared.type;
        values.table_id = prepared.tableId;
        values.config = prepared.config;
      }
      if (patch.title !== undefined) values.title = trimmed(patch.title, 'Widget title', 120);
      if (patch.layout !== undefined) values.layout = JSON.stringify(normalizeWidgetLayout(patch.layout));
      if (patch.position !== undefined) values.position = patch.position;
      const rows = await db
        .update(tableDashboardWidgets)
        .set(values)
        .where(and(eq(tableDashboardWidgets.id, id), eq(tableDashboardWidgets.revision, patch.revision)))
        .returning();
      if (rows[0]) return { ok: true, value: rows[0] };
      const latest = await service.getDashboardWidget(id);
      return latest ? { ok: false, reason: 'conflict', current: latest.revision } : { ok: false, reason: 'not_found' };
    },

    async deleteDashboardWidget(id: number): Promise<boolean> {
      const rows = await db
        .delete(tableDashboardWidgets)
        .where(eq(tableDashboardWidgets.id, id))
        .returning({ id: tableDashboardWidgets.id });
      return rows.length > 0;
    },
  };
  return service;
}
