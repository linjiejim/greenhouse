/**
 * What the Tables config validators read about the schema.
 *
 * Every validator that checks a configuration against the live schema — field
 * model configs (relation / formula / lookup / rollup), view configs, form
 * configs and audiences, automation configs, dashboard filters and widget cards
 * — reads it through this interface instead of querying directly. Write paths
 * pass `dbSchemaSource(executor)`; the plan tool's draft check passes a virtual
 * source (the existing schema as the drafter reads it, plus the objects the
 * plan declares under placeholder ids). So "what the draft check refuses" and
 * "what the write refuses" are the same code (spec 20261011-tables-foundation §9).
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { TableAccessScope } from '@greenhouse/types/table-access';
import { tableFields, tableTables, userGroups, users } from '../../schema/index.js';
import type { TableFieldRow } from '../../schema/tables.js';
import { buildCompileContext, type TableCompileContext, type TableQueryEvaluation } from './query.js';
import type { TablesExecutor } from './shared.js';

/** A table as the validators need it. */
export interface TablesSourceTable {
  id: number;
  base_id: number;
  archived: boolean;
}

export interface TablesSchemaSource {
  /** A table (archived ones included, flagged), or undefined when it does not exist / is not visible. */
  table(tableId: number): Promise<TablesSourceTable | undefined>;
  /** A table's active fields, in display order (empty when the table is unknown). */
  fields(tableId: number): Promise<TableFieldRow[]>;
  /** Active internal users (team / super). */
  activeUserIds(): Promise<ReadonlySet<string>>;
  /** Of these group ids, the ones that exist (a stricter source may answer "the ones you may name"). */
  existingGroupIds(ids: readonly number[]): Promise<ReadonlySet<number>>;
}

/** The live schema, read with `executor` (the provider's db or a transaction). */
export function dbSchemaSource(executor: TablesExecutor): TablesSchemaSource {
  let activeUsers: Promise<Set<string>> | undefined;
  return {
    async table(tableId) {
      const [row] = await executor
        .select({ id: tableTables.id, base_id: tableTables.base_id, archived_at: tableTables.archived_at })
        .from(tableTables)
        .where(eq(tableTables.id, tableId))
        .limit(1);
      return row ? { id: row.id, base_id: row.base_id, archived: row.archived_at !== null } : undefined;
    },
    fields(tableId) {
      return executor
        .select()
        .from(tableFields)
        .where(and(eq(tableFields.table_id, tableId), isNull(tableFields.archived_at)))
        .orderBy(asc(tableFields.position), asc(tableFields.id));
    },
    activeUserIds() {
      activeUsers ??= executor
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.status, 'active'), inArray(users.role, ['team', 'super'])))
        .then((rows) => new Set(rows.map((row) => row.id)));
      return activeUsers;
    },
    async existingGroupIds(ids) {
      if (ids.length === 0) return new Set();
      const rows = await executor
        .select({ id: userGroups.id })
        .from(userGroups)
        .where(inArray(userGroups.id, [...ids]));
      return new Set(rows.map((row) => row.id));
    },
  };
}

/** The compile context of one table as `scope` sees it, built from a source (no SQL is run). */
export async function sourceCompileContext(
  source: TablesSchemaSource,
  tableId: number,
  scope: TableAccessScope,
  evaluation?: TableQueryEvaluation,
): Promise<TableCompileContext> {
  const [fields, activeUserIds] = await Promise.all([source.fields(tableId), source.activeUserIds()]);
  return buildCompileContext(tableId, fields, activeUserIds, scope, evaluation);
}
