/**
 * Dashboards and widgets (configuration only — evaluation goes through the
 * scoped record query / aggregate paths). The unified card spec and dashboard
 * filters arrive with slice D.
 */

import { and, asc, eq } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { TABLE_AGGREGATIONS, TABLE_DASHBOARD_WIDGET_TYPES } from '@greenhouse/types/tables';
import type {
  TableDashboardWidgetConfig,
  TableDashboardWidgetLayout,
  TableDashboardWidgetType,
} from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import { tableDashboardWidgets, tableDashboards } from '../../schema/index.js';
import type { TableDashboardRow, TableDashboardWidgetRow } from '../../schema/tables.js';
import { validateQueryShape } from './query.js';
import { isPositiveInteger, TablesValidationError, trimmed, type TableRevisionResult } from './shared.js';

export interface CreateTableDashboardInput {
  base_id: number;
  name: string;
  description?: string | null;
  created_by: string;
}

export interface CreateTableDashboardWidgetInput {
  dashboard_id: number;
  table_id?: number | null;
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

function validateWidgetType(type: TableDashboardWidgetType): void {
  if (!TABLE_DASHBOARD_WIDGET_TYPES.includes(type)) {
    throw new TablesValidationError(`Unsupported dashboard widget type "${type}"`);
  }
}

function normalizeWidgetConfig(
  type: TableDashboardWidgetType,
  input: TableDashboardWidgetConfig = {},
): TableDashboardWidgetConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TablesValidationError('Widget config must be an object');
  }
  if (type === 'text') {
    if (input.text !== undefined && typeof input.text !== 'string') {
      throw new TablesValidationError('Text widget content must be text');
    }
    if ((input.text?.length ?? 0) > 100_000) throw new TablesValidationError('Text widget exceeds 100,000 characters');
    return { version: 1, text: input.text ?? '' };
  }
  const operation = input.operation ?? 'count';
  if (!TABLE_AGGREGATIONS.includes(operation)) {
    throw new TablesValidationError(`Unsupported aggregation "${operation}"`);
  }
  if (input.valueFieldId !== undefined && !isPositiveInteger(input.valueFieldId)) {
    throw new TablesValidationError('valueFieldId must be a positive integer');
  }
  if (input.groupByFieldId !== undefined && !isPositiveInteger(input.groupByFieldId)) {
    throw new TablesValidationError('groupByFieldId must be a positive integer');
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
    throw new TablesValidationError('Widget limit must be between 1 and 100');
  }
  if (input.query !== undefined) validateQueryShape(input.query);
  return {
    version: 1,
    operation,
    ...(input.valueFieldId ? { valueFieldId: input.valueFieldId } : {}),
    ...(input.groupByFieldId ? { groupByFieldId: input.groupByFieldId } : {}),
    ...(input.query ? { query: input.query } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  };
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

export function createTablesDashboards(db: Db) {
  const service = {
    async createDashboard(input: CreateTableDashboardInput): Promise<TableDashboardRow> {
      const now = nowIso();
      const [row] = await db
        .insert(tableDashboards)
        .values({
          base_id: input.base_id,
          name: trimmed(input.name, 'Dashboard name', 120),
          description: input.description?.trim() || null,
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
      validateWidgetType(input.type);
      if (input.type !== 'text' && !input.table_id) {
        throw new TablesValidationError(`${input.type} widgets require table_id`);
      }
      const config = normalizeWidgetConfig(input.type, input.config);
      const layout = normalizeWidgetLayout(input.layout);
      const now = nowIso();
      const [row] = await db
        .insert(tableDashboardWidgets)
        .values({
          dashboard_id: input.dashboard_id,
          table_id: input.table_id ?? null,
          type: input.type,
          title: trimmed(input.title, 'Widget title', 120),
          config: JSON.stringify(config),
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
      if (patch.table_id !== undefined) values.table_id = patch.table_id;
      if (patch.title !== undefined) values.title = trimmed(patch.title, 'Widget title', 120);
      if (patch.config !== undefined) values.config = JSON.stringify(normalizeWidgetConfig(current.type, patch.config));
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
