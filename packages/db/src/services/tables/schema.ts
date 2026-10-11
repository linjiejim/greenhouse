/**
 * Structure: Bases, tables, fields, schema versions and field dependencies.
 */

import { and, asc, desc, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { isComputedFieldType } from '@greenhouse/types/tables';
import type {
  TableBaseVisibility,
  TableFieldConfig,
  TableFieldType,
  TableSchemaChangeType,
  TableViewConfig,
} from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import {
  tableBaseMembers,
  tableBases,
  tableFieldDependencies,
  tableFields,
  tableSchemaVersions,
  tableTables,
  tableViews,
} from '../../schema/index.js';
import type {
  TableBaseRow,
  TableDefinitionRow,
  TableFieldDependencyRow,
  TableFieldRow,
  TableSchemaVersionRow,
  TableViewRow,
} from '../../schema/tables.js';
import type { TablesCompute } from './compute.js';
import {
  buildSchemaSnapshot,
  escapeLike,
  formulaFieldIds,
  isComputedField,
  MAX_FIELDS,
  parseTableFieldConfig,
  TablesValidationError,
  trimmed,
  validateFieldType,
  validateTableFieldConfig,
  type TablesTransaction,
} from './shared.js';

export interface CreateTableBaseInput {
  name: string;
  description?: string | null;
  visibility?: TableBaseVisibility;
  owner_id: string;
  created_by: string;
}

export interface UpdateTableBaseInput {
  name?: string;
  description?: string | null;
  visibility?: TableBaseVisibility;
}

export interface CreateTableDefinitionInput {
  base_id: number;
  name: string;
  description?: string | null;
  created_by: string;
}

export interface CreateTableFieldInput {
  table_id: number;
  name: string;
  type: TableFieldType;
  required?: boolean;
  config?: TableFieldConfig;
  position?: number;
  created_by: string;
}

export interface UpdateTableFieldInput {
  updated_by: string;
  name?: string;
  required?: boolean;
  config?: TableFieldConfig;
  position?: number;
}

export interface TableSchemaResult {
  table: TableDefinitionRow;
  fields: TableFieldRow[];
  views: TableViewRow[];
}

export function createTablesSchema(
  db: Db,
  deps: {
    compute: TablesCompute;
    listViews: (tableId: number, userId?: string) => Promise<TableViewRow[]>;
  },
) {
  const writeSchemaVersion = async (
    tx: TablesTransaction,
    tableId: number,
    changeType: TableSchemaChangeType,
    changedBy: string,
  ): Promise<number> => {
    const [table] = await tx
      .select({ schema_revision: tableTables.schema_revision })
      .from(tableTables)
      .where(eq(tableTables.id, tableId))
      .limit(1)
      .for('update');
    if (!table) throw new TablesValidationError(`Table ${tableId} is unavailable`);
    const fields = await tx
      .select()
      .from(tableFields)
      .where(eq(tableFields.table_id, tableId))
      .orderBy(asc(tableFields.position), asc(tableFields.id));
    const nextVersion = table.schema_revision + 1;
    const now = nowIso();
    await tx
      .update(tableTables)
      .set({ schema_revision: nextVersion, updated_at: now })
      .where(eq(tableTables.id, tableId));
    await tx.insert(tableSchemaVersions).values({
      table_id: tableId,
      version: nextVersion,
      schema_snapshot: buildSchemaSnapshot(tableId, fields),
      change_type: changeType,
      changed_by: changedBy,
      created_at: now,
    });
    return nextVersion;
  };

  const syncFieldDependencies = async (
    tx: TablesTransaction,
    field: TableFieldRow,
    config: TableFieldConfig,
  ): Promise<void> => {
    await tx.delete(tableFieldDependencies).where(eq(tableFieldDependencies.field_id, field.id));
    const dependencies =
      field.type === 'formula' && config.formula
        ? [...formulaFieldIds(config.formula.expression)].map((dependsOnFieldId) => ({
            field_id: field.id,
            depends_on_field_id: dependsOnFieldId,
            dependency_type: 'formula' as const,
          }))
        : field.type === 'rollup' && config.rollup
          ? [config.rollup.relationFieldId, config.rollup.targetFieldId].map((dependsOnFieldId) => ({
              field_id: field.id,
              depends_on_field_id: dependsOnFieldId,
              dependency_type: 'rollup' as const,
            }))
          : [];
    if (dependencies.length > 0) await tx.insert(tableFieldDependencies).values(dependencies);
  };

  const validateModelConfig = async (
    tableId: number,
    type: TableFieldType,
    config: TableFieldConfig,
    fieldId?: number,
  ): Promise<void> => {
    if (type === 'relation') {
      const [source, target] = await Promise.all([
        db.select().from(tableTables).where(eq(tableTables.id, tableId)).limit(1),
        db.select().from(tableTables).where(eq(tableTables.id, config.relation!.targetTableId)).limit(1),
      ]);
      if (!source[0] || !target[0] || source[0].base_id !== target[0].base_id || target[0].archived_at) {
        throw new TablesValidationError('Relation target must be an active table in the same Base');
      }
      return;
    }
    if (type === 'formula') {
      const fields = await db
        .select()
        .from(tableFields)
        .where(and(eq(tableFields.table_id, tableId), isNull(tableFields.archived_at)));
      const byId = new Map(fields.map((field) => [field.id, field]));
      for (const dependencyId of formulaFieldIds(config.formula!.expression)) {
        const dependency = byId.get(dependencyId);
        if (!dependency || dependency.id === fieldId) {
          throw new TablesValidationError(`Formula field ${dependencyId} is unavailable`);
        }
        if (isComputedField(dependency)) {
          throw new TablesValidationError('Formula fields may reference stored fields only');
        }
      }
      return;
    }
    if (type === 'rollup') {
      const rollup = config.rollup!;
      const [relationField] = await db
        .select()
        .from(tableFields)
        .where(
          and(
            eq(tableFields.id, rollup.relationFieldId),
            eq(tableFields.table_id, tableId),
            isNull(tableFields.archived_at),
          ),
        )
        .limit(1);
      if (!relationField || relationField.type !== 'relation') {
        throw new TablesValidationError('Rollup relationFieldId must reference a relation field on this table');
      }
      const relation = parseTableFieldConfig(relationField).relation;
      const [targetField] = await db
        .select()
        .from(tableFields)
        .where(
          and(
            eq(tableFields.id, rollup.targetFieldId),
            eq(tableFields.table_id, relation!.targetTableId),
            isNull(tableFields.archived_at),
          ),
        )
        .limit(1);
      if (!targetField) throw new TablesValidationError('Rollup target field is unavailable');
      const numericTarget =
        targetField.type === 'number' ||
        (targetField.type === 'formula' && parseTableFieldConfig(targetField).formula?.resultType === 'number');
      if (['sum', 'avg', 'min', 'max'].includes(rollup.aggregation) && !numericTarget) {
        throw new TablesValidationError(`${rollup.aggregation} rollups require a numeric target field`);
      }
    }
  };

  const service = {
    async getBase(id: number): Promise<TableBaseRow | undefined> {
      const rows = await db.select().from(tableBases).where(eq(tableBases.id, id)).limit(1);
      return rows[0];
    },

    async listBasesForUser(userId: string, search?: string): Promise<TableBaseRow[]> {
      const conditions: SQL[] = [
        isNull(tableBases.archived_at),
        or(
          eq(tableBases.owner_id, userId),
          eq(tableBases.visibility, 'team'),
          sql`EXISTS (
            SELECT 1 FROM table_base_members
            WHERE table_base_members.base_id = ${tableBases.id}
              AND table_base_members.user_id = ${userId}
          )`,
          // Group grants reach only listed members (`group_members`), never a
          // group's creator by that fact alone. Candidates only: the API's
          // resolver decides the level (and drops dangling custom grants).
          sql`EXISTS (
            SELECT 1 FROM table_base_group_members g
            JOIN group_members m ON m.group_id = g.group_id
            WHERE g.base_id = ${tableBases.id}
              AND m.user_id = ${userId}
          )`,
        )!,
      ];
      if (search?.trim()) {
        conditions.push(sql`${tableBases.name} ILIKE ${`%${escapeLike(search.trim())}%`} ESCAPE '\\'`);
      }
      return db
        .select()
        .from(tableBases)
        .where(and(...conditions))
        .orderBy(desc(tableBases.updated_at));
    },

    async createBase(input: CreateTableBaseInput): Promise<TableBaseRow> {
      const now = nowIso();
      return db.transaction(async (tx) => {
        const [base] = await tx
          .insert(tableBases)
          .values({
            name: trimmed(input.name, 'Base name', 120),
            description: input.description?.trim() || null,
            visibility: input.visibility ?? 'private',
            owner_id: input.owner_id,
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
          })
          .returning();
        await tx.insert(tableBaseMembers).values({
          base_id: base!.id,
          user_id: input.owner_id,
          role: 'owner',
          added_by: input.created_by,
          created_at: now,
          updated_at: now,
        });
        return base!;
      });
    },

    async updateBase(id: number, patch: UpdateTableBaseInput): Promise<TableBaseRow | undefined> {
      const values: Partial<TableBaseRow> = { updated_at: nowIso() };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'Base name', 120);
      if (patch.description !== undefined) values.description = patch.description?.trim() || null;
      if (patch.visibility !== undefined) values.visibility = patch.visibility;
      const rows = await db.update(tableBases).set(values).where(eq(tableBases.id, id)).returning();
      return rows[0];
    },

    async archiveBase(id: number): Promise<TableBaseRow | undefined> {
      const now = nowIso();
      const rows = await db
        .update(tableBases)
        .set({ archived_at: now, updated_at: now })
        .where(and(eq(tableBases.id, id), isNull(tableBases.archived_at)))
        .returning();
      return rows[0];
    },

    async restoreBase(id: number): Promise<TableBaseRow | undefined> {
      const rows = await db
        .update(tableBases)
        .set({ archived_at: null, updated_at: nowIso() })
        .where(eq(tableBases.id, id))
        .returning();
      return rows[0];
    },

    async listArchivedBases(): Promise<TableBaseRow[]> {
      return db
        .select()
        .from(tableBases)
        .where(isNotNull(tableBases.archived_at))
        .orderBy(desc(tableBases.archived_at));
    },

    async getTable(id: number): Promise<TableDefinitionRow | undefined> {
      const rows = await db.select().from(tableTables).where(eq(tableTables.id, id)).limit(1);
      return rows[0];
    },

    async listTables(baseId: number): Promise<TableDefinitionRow[]> {
      return db
        .select()
        .from(tableTables)
        .where(and(eq(tableTables.base_id, baseId), isNull(tableTables.archived_at)))
        .orderBy(asc(tableTables.position), asc(tableTables.id));
    },

    async createTable(input: CreateTableDefinitionInput): Promise<TableSchemaResult> {
      const now = nowIso();
      return db.transaction(async (tx) => {
        const [{ nextPosition }] = await tx
          .select({ nextPosition: sql<number>`coalesce(max(${tableTables.position}), -1) + 1` })
          .from(tableTables)
          .where(eq(tableTables.base_id, input.base_id));
        const [table] = await tx
          .insert(tableTables)
          .values({
            base_id: input.base_id,
            name: trimmed(input.name, 'Table name', 120),
            description: input.description?.trim() || null,
            position: Number(nextPosition),
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
          })
          .returning();
        const [field] = await tx
          .insert(tableFields)
          .values({
            table_id: table!.id,
            name: 'Name',
            type: 'text',
            required: true,
            is_primary: true,
            config: JSON.stringify({ version: 1 } satisfies TableFieldConfig),
            position: 0,
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
          })
          .returning();
        const [view] = await tx
          .insert(tableViews)
          .values({
            table_id: table!.id,
            name: 'Grid',
            type: 'grid',
            scope: 'shared',
            config: JSON.stringify({ version: 1, fieldIds: [field!.id] } satisfies TableViewConfig),
            position: 0,
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
          })
          .returning();
        await tx.insert(tableSchemaVersions).values({
          table_id: table!.id,
          version: 1,
          schema_snapshot: buildSchemaSnapshot(table!.id, [field!]),
          change_type: 'created',
          changed_by: input.created_by,
          created_at: now,
        });
        return { table: table!, fields: [field!], views: [view!] };
      });
    },

    async updateTable(
      id: number,
      patch: { name?: string; description?: string | null; position?: number },
    ): Promise<TableDefinitionRow | undefined> {
      const values: Partial<TableDefinitionRow> = { updated_at: nowIso() };
      if (patch.name !== undefined) values.name = trimmed(patch.name, 'Table name', 120);
      if (patch.description !== undefined) values.description = patch.description?.trim() || null;
      if (patch.position !== undefined) values.position = patch.position;
      const rows = await db.update(tableTables).set(values).where(eq(tableTables.id, id)).returning();
      return rows[0];
    },

    /**
     * Archiving a table hides it everywhere (listTables/getSchema already filter
     * on archived_at) but touches no record, link or field. Relations pointing
     * at it keep their rows; creating new links to an archived table is already
     * refused upstream, and its rollups simply stop refreshing.
     */
    async archiveTable(id: number): Promise<TableDefinitionRow | undefined> {
      const now = nowIso();
      const rows = await db
        .update(tableTables)
        .set({ archived_at: now, updated_at: now })
        .where(and(eq(tableTables.id, id), isNull(tableTables.archived_at)))
        .returning();
      return rows[0];
    },

    async restoreTable(id: number): Promise<TableDefinitionRow | undefined> {
      const rows = await db
        .update(tableTables)
        .set({ archived_at: null, updated_at: nowIso() })
        .where(eq(tableTables.id, id))
        .returning();
      return rows[0];
    },

    async listArchivedTables(baseId?: number): Promise<TableDefinitionRow[]> {
      const conditions: SQL[] = [isNotNull(tableTables.archived_at)];
      if (baseId !== undefined) conditions.push(eq(tableTables.base_id, baseId));
      return db
        .select()
        .from(tableTables)
        .where(and(...conditions))
        .orderBy(desc(tableTables.archived_at));
    },

    async getField(id: number): Promise<TableFieldRow | undefined> {
      const rows = await db.select().from(tableFields).where(eq(tableFields.id, id)).limit(1);
      return rows[0];
    },

    async listSchemaVersions(tableId: number): Promise<TableSchemaVersionRow[]> {
      return db
        .select()
        .from(tableSchemaVersions)
        .where(eq(tableSchemaVersions.table_id, tableId))
        .orderBy(desc(tableSchemaVersions.version));
    },

    async getSchemaVersion(tableId: number, version: number): Promise<TableSchemaVersionRow | undefined> {
      const rows = await db
        .select()
        .from(tableSchemaVersions)
        .where(and(eq(tableSchemaVersions.table_id, tableId), eq(tableSchemaVersions.version, version)))
        .limit(1);
      return rows[0];
    },

    async listFields(tableId: number, includeArchived = false): Promise<TableFieldRow[]> {
      const conditions = [eq(tableFields.table_id, tableId)];
      if (!includeArchived) conditions.push(isNull(tableFields.archived_at));
      return db
        .select()
        .from(tableFields)
        .where(and(...conditions))
        .orderBy(asc(tableFields.position), asc(tableFields.id));
    },

    async listFieldDependencies(fieldId: number): Promise<TableFieldDependencyRow[]> {
      return db
        .select()
        .from(tableFieldDependencies)
        .where(eq(tableFieldDependencies.field_id, fieldId))
        .orderBy(asc(tableFieldDependencies.depends_on_field_id));
    },

    async createField(input: CreateTableFieldInput): Promise<TableFieldRow> {
      validateFieldType(input.type);
      const config = validateTableFieldConfig(input.type, input.config ?? {});
      await validateModelConfig(input.table_id, input.type, config);
      const now = nowIso();
      const row = await db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(tableFields)
          .where(and(eq(tableFields.table_id, input.table_id), isNull(tableFields.archived_at)))
          .orderBy(asc(tableFields.position), asc(tableFields.id));
        if (current.length >= MAX_FIELDS) {
          throw new TablesValidationError(`A table supports at most ${MAX_FIELDS} fields`);
        }
        const nextPosition = input.position ?? (current.at(-1)?.position ?? -1) + 1;
        const [row] = await tx
          .insert(tableFields)
          .values({
            table_id: input.table_id,
            name: trimmed(input.name, 'Field name', 120),
            type: input.type,
            required: input.required ?? false,
            config: JSON.stringify(config),
            position: nextPosition,
            created_by: input.created_by,
            created_at: now,
            updated_at: now,
          })
          .returning();
        await syncFieldDependencies(tx, row!, config);
        await writeSchemaVersion(tx, input.table_id, 'field_created', input.created_by);
        return row!;
      });
      if (isComputedFieldType(input.type)) await deps.compute.recomputeTable(input.table_id);
      return row;
    },

    async updateField(id: number, patch: UpdateTableFieldInput): Promise<TableFieldRow | undefined> {
      const existing = await service.getField(id);
      if (!existing || existing.archived_at) return undefined;
      const normalizedConfig =
        patch.config === undefined ? undefined : validateTableFieldConfig(existing.type, patch.config);
      if (normalizedConfig) {
        await validateModelConfig(existing.table_id, existing.type, normalizedConfig, existing.id);
      }
      const row = await db.transaction(async (tx) => {
        const [field] = await tx.select().from(tableFields).where(eq(tableFields.id, id)).limit(1);
        if (!field || field.archived_at) return undefined;
        const values: Partial<TableFieldRow> = { updated_at: nowIso() };
        if (patch.name !== undefined) values.name = trimmed(patch.name, 'Field name', 120);
        if (patch.required !== undefined) values.required = field.is_primary ? true : patch.required;
        if (normalizedConfig !== undefined) values.config = JSON.stringify(normalizedConfig);
        if (patch.position !== undefined) values.position = patch.position;
        const rows = await tx.update(tableFields).set(values).where(eq(tableFields.id, id)).returning();
        await syncFieldDependencies(tx, rows[0]!, normalizedConfig ?? parseTableFieldConfig(rows[0]!));
        await writeSchemaVersion(tx, field.table_id, 'field_updated', patch.updated_by);
        return rows[0];
      });
      if (row && isComputedField(row)) await deps.compute.recomputeTable(row.table_id);
      return row;
    },

    async archiveField(id: number, userId: string): Promise<TableFieldRow | undefined> {
      const row = await db.transaction(async (tx) => {
        const [field] = await tx.select().from(tableFields).where(eq(tableFields.id, id)).limit(1);
        if (!field || field.archived_at || field.is_primary) return undefined;
        const now = nowIso();
        const rows = await tx
          .update(tableFields)
          .set({ archived_at: now, updated_at: now })
          .where(eq(tableFields.id, id))
          .returning();
        await tx
          .delete(tableFieldDependencies)
          .where(
            or(eq(tableFieldDependencies.field_id, field.id), eq(tableFieldDependencies.depends_on_field_id, field.id)),
          );
        await writeSchemaVersion(tx, field.table_id, 'field_archived', userId);
        return rows[0];
      });
      if (row && isComputedField(row)) await deps.compute.recomputeTable(row.table_id);
      return row;
    },

    async getSchema(tableId: number, userId?: string): Promise<TableSchemaResult | undefined> {
      const table = await service.getTable(tableId);
      if (!table || table.archived_at) return undefined;
      const [fields, views] = await Promise.all([service.listFields(tableId), deps.listViews(tableId, userId)]);
      return { table, fields, views };
    },
  };
  return service;
}
