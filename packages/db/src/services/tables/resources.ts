/**
 * Which Base owns a Tables resource — resolved for every audited Tables action
 * before its handler runs and stamped on the audit event as its scope
 * (`scope_type = 'base'`), so the Base audit feed is one indexed read.
 *
 * Ownership only: archived Bases / tables and deleted records still resolve
 * (the audit outlives them). Never returns anything to a client.
 */

import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../../client.js';
import {
  tableApps,
  tableAutomationRules,
  tableBaseRoles,
  tableDashboards,
  tableDashboardWidgets,
  tableFields,
  tableForms,
  tableRecordComments,
  tableRecords,
  tableTables,
  tableViews,
} from '../../schema/index.js';

/** The resource kinds a Tables action is audited against (`tablesResource` in the API). */
export const TABLES_RESOURCE_KINDS = [
  'base',
  'table',
  'field',
  'view',
  'form',
  'record',
  'automation',
  'dashboard',
  'widget',
  'role',
  'comment',
  'app',
] as const;
export type TablesResourceKind = (typeof TABLES_RESOURCE_KINDS)[number];

export function createTablesResources(db: Db) {
  /** Table id → Base id for resources that hang off a table. */
  const viaTable = async (rows: Array<{ id: number; tableId: number }>): Promise<Map<number, number>> => {
    const tableIds = [...new Set(rows.map((row) => row.tableId))];
    if (tableIds.length === 0) return new Map();
    const tables = await db
      .select({ id: tableTables.id, baseId: tableTables.base_id })
      .from(tableTables)
      .where(inArray(tableTables.id, tableIds));
    const baseByTable = new Map(tables.map((table) => [table.id, table.baseId]));
    const out = new Map<number, number>();
    for (const row of rows) {
      const baseId = baseByTable.get(row.tableId);
      if (baseId !== undefined) out.set(row.id, baseId);
    }
    return out;
  };

  return {
    /** Resource id → owning Base id, for every id that still exists (a Base id maps to itself). */
    async baseIdsForResources(kind: TablesResourceKind, ids: readonly number[]): Promise<Map<number, number>> {
      const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
      if (unique.length === 0) return new Map();
      switch (kind) {
        case 'base':
          return new Map(unique.map((id) => [id, id]));
        case 'table':
          return viaTable(unique.map((id) => ({ id, tableId: id })));
        case 'field':
          return viaTable(
            await db
              .select({ id: tableFields.id, tableId: tableFields.table_id })
              .from(tableFields)
              .where(inArray(tableFields.id, unique)),
          );
        case 'view':
          return viaTable(
            await db
              .select({ id: tableViews.id, tableId: tableViews.table_id })
              .from(tableViews)
              .where(inArray(tableViews.id, unique)),
          );
        case 'form':
          return viaTable(
            await db
              .select({ id: tableForms.id, tableId: tableForms.table_id })
              .from(tableForms)
              .where(inArray(tableForms.id, unique)),
          );
        case 'record':
          return viaTable(
            await db
              .select({ id: tableRecords.id, tableId: tableRecords.table_id })
              .from(tableRecords)
              .where(inArray(tableRecords.id, unique)),
          );
        case 'comment':
          return viaTable(
            await db
              .select({ id: tableRecordComments.id, tableId: tableRecordComments.table_id })
              .from(tableRecordComments)
              .where(inArray(tableRecordComments.id, unique)),
          );
        case 'automation': {
          const rows = await db
            .select({ id: tableAutomationRules.id, baseId: tableAutomationRules.base_id })
            .from(tableAutomationRules)
            .where(inArray(tableAutomationRules.id, unique));
          return new Map(rows.map((row) => [row.id, row.baseId]));
        }
        case 'dashboard': {
          const rows = await db
            .select({ id: tableDashboards.id, baseId: tableDashboards.base_id })
            .from(tableDashboards)
            .where(inArray(tableDashboards.id, unique));
          return new Map(rows.map((row) => [row.id, row.baseId]));
        }
        case 'widget': {
          const rows = await db
            .select({ id: tableDashboardWidgets.id, baseId: tableDashboards.base_id })
            .from(tableDashboardWidgets)
            .innerJoin(tableDashboards, eq(tableDashboards.id, tableDashboardWidgets.dashboard_id))
            .where(inArray(tableDashboardWidgets.id, unique));
          return new Map(rows.map((row) => [row.id, row.baseId]));
        }
        case 'role': {
          const rows = await db
            .select({ id: tableBaseRoles.id, baseId: tableBaseRoles.base_id })
            .from(tableBaseRoles)
            .where(inArray(tableBaseRoles.id, unique));
          return new Map(rows.map((row) => [row.id, row.baseId]));
        }
        case 'app': {
          const rows = await db
            .select({ id: tableApps.id, baseId: tableApps.base_id })
            .from(tableApps)
            .where(inArray(tableApps.id, unique));
          return new Map(rows.map((row) => [row.id, row.baseId]));
        }
      }
    },
  };
}
