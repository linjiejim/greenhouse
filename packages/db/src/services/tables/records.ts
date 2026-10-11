/**
 * Record data: validation, writes, reads, queries.
 *
 * Every read, write and aggregate takes a non-optional `TableAccessScope`
 * (`fullTableAccess(userId)` for built-in roles, automations, imports and
 * recompute), and every write a non-optional `TableRecordWriteMeta`. A scoped
 * scope is enforced here, not by callers: read rows, edit rows for update /
 * delete / restore, editable field keys, create / delete rights, and required
 * fields only among the editable ones (spec D3). Out-of-scope ids are
 * indistinguishable from missing ones.
 *
 * A write is one transaction: the row, its link / attachment edges, its
 * computed values, and `onRecordWritten` (history + automation enqueue).
 */

import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type {
  TableBatchValidationResult,
  TableFieldConfig,
  TableQuery,
  TableRecordValues,
  TableRecordWriteMeta,
} from '@greenhouse/types/tables';
import type { TableAccessScope } from '@greenhouse/types/table-access';
import type { Db } from '../../client.js';
import {
  driveFiles,
  tableFields,
  tableRecordAttachments,
  tableRecordLinks,
  tableRecomputeJobs,
  tableRecords,
  tableTables,
  users,
} from '../../schema/index.js';
import type {
  TableFieldRow,
  TableRecomputeJobRow,
  TableRecordAttachmentRow,
  TableRecordLinkRow,
  TableRecordRow,
} from '../../schema/tables.js';
import { onRecordWritten } from './activity.js';
import type { TablesCompute } from './compute.js';
import {
  assertScopeForTable,
  compileRecordQuery,
  encodeCursor,
  loadCompileContext,
  scopeRowPredicate,
  type TableQueryEvaluation,
  type TableRecordQueryParts,
} from './query.js';
import {
  assertScope,
  assertWriteMeta,
  isComputedField,
  isPositiveInteger,
  MAX_BATCH_RECORDS,
  parseTableFieldConfig,
  recordSnapshot,
  TablesValidationError,
  validateTableFieldValue,
  type TablesExecutor,
  type TablesTransaction,
} from './shared.js';

export interface CreateTableRecordInput {
  table_id: number;
  values: TableRecordValues;
}

export interface UpdateTableRecordInput {
  table_id: number;
  record_id: number;
  revision: number;
  values: TableRecordValues;
}

export interface DeleteTableRecordInput {
  table_id: number;
  record_id: number;
  revision: number;
}

export interface RestoreTableRecordInput {
  table_id: number;
  record_id: number;
}

export interface BatchUpsertTableRecordItem {
  record_id?: number;
  revision?: number;
  values: TableRecordValues;
}

export type TableRecordWriteResult =
  | { ok: true; record: TableRecordRow }
  | { ok: false; reason: 'not_found' | 'conflict'; current?: number };

export type TableBatchUpsertResult =
  | { index: number; ok: true; record: TableRecordRow }
  | { index: number; ok: false; reason: 'not_found' | 'conflict' | 'invalid'; message?: string; current?: number };

export interface TableRecordQueryResult {
  records: TableRecordRow[];
  total: number;
  nextCursor: string | null;
}

export interface TableValidationContext {
  fields: TableFieldRow[];
  byId: Map<string, TableFieldRow>;
  activeUserIds: Set<string>;
  relationTargets: Map<string, Set<number>>;
  attachmentFileIds: Set<number>;
}

/** Extra work a caller runs inside the record's write transaction (e.g. the form submission row). */
export interface RecordWriteHooks {
  inTransaction?: (tx: TablesTransaction, record: TableRecordRow) => Promise<void>;
}

export interface TablesRecordsDeps {
  compute: TablesCompute;
  /**
   * After commit, for writes with `meta.enqueueAutomations`: the legacy
   * synchronous automation executor. Slice Au moves rule matching into
   * `enqueueAutomationEvents` (inside the transaction) and drops this.
   */
  afterCommit: (
    trigger: 'record_created' | 'record_updated',
    record: TableRecordRow,
    meta: TableRecordWriteMeta,
  ) => Promise<void>;
}

function assertEditableKeys(scope: TableAccessScope, values: TableRecordValues): void {
  if (scope.kind === 'full') return;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return;
  const editable = new Set(scope.editableFieldIds.map(String));
  const blocked = Object.keys(values).find((key) => !editable.has(key));
  if (blocked !== undefined) {
    throw new TablesValidationError(`Field ${blocked} is not editable`, 'field_not_editable');
  }
}

function validateValuesWithContext(
  context: TableValidationContext,
  values: TableRecordValues,
  options: { requireAll: boolean; scope: TableAccessScope },
): TableRecordValues {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new TablesValidationError('values must be an object keyed by field id');
  }
  const normalized: TableRecordValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (!/^\d+$/.test(key)) throw new TablesValidationError(`Invalid field id "${key}"`);
    const field = context.byId.get(key);
    if (!field) throw new TablesValidationError(`Field ${key} is unavailable`);
    if (isComputedField(field)) {
      throw new TablesValidationError(`Field "${field.name}" is computed and cannot be written`);
    }
    const nextValue = validateTableFieldValue(field, value, context.activeUserIds);
    if (field.type === 'relation' && nextValue !== null) {
      const validIds = context.relationTargets.get(key) ?? new Set<number>();
      const ids = Array.isArray(nextValue) ? (nextValue as number[]) : [nextValue as number];
      if (ids.some((id) => !validIds.has(id))) {
        throw new TablesValidationError(`Field "${field.name}" references an unavailable record`);
      }
    }
    if (field.type === 'attachment' && Array.isArray(nextValue)) {
      const numericIds = nextValue.filter((entry): entry is number => typeof entry === 'number');
      if (numericIds.some((id) => !context.attachmentFileIds.has(id))) {
        throw new TablesValidationError(`Field "${field.name}" references an unavailable Base file`);
      }
    }
    normalized[key] = nextValue;
  }
  if (options.requireAll) {
    // D3: a scoped writer is only held to the required fields it can edit —
    // otherwise a role that cannot touch a required column could never create.
    const editable = options.scope.kind === 'scoped' ? new Set(options.scope.editableFieldIds) : null;
    for (const field of context.fields) {
      if (isComputedField(field) || !field.required) continue;
      if (editable && !editable.has(field.id)) continue;
      const value = normalized[String(field.id)];
      if (value === undefined || value === null || value === '') {
        throw new TablesValidationError(`Field "${field.name}" is required`);
      }
    }
  }
  return normalized;
}

export function createTablesRecords(db: Db, deps: TablesRecordsDeps) {
  const { compute } = deps;

  const loadValidationContext = async (tableId: number): Promise<TableValidationContext> => {
    const fields = await db
      .select()
      .from(tableFields)
      .where(and(eq(tableFields.table_id, tableId), isNull(tableFields.archived_at)))
      .orderBy(asc(tableFields.position), asc(tableFields.id));
    const needsUsers = fields.some((field) => field.type === 'user' || field.type === 'multi_user');
    const needsAttachments = fields.some((field) => field.type === 'attachment');
    const activeUserIds = needsUsers
      ? new Set(
          (
            await db
              .select({ id: users.id })
              .from(users)
              .where(and(eq(users.status, 'active'), inArray(users.role, ['team', 'super'])))
          ).map((row) => row.id),
        )
      : new Set<string>();
    const relationFields = fields
      .filter((field) => field.type === 'relation')
      .map((field) => ({ field, config: parseTableFieldConfig(field) }))
      .filter(
        (
          entry,
        ): entry is { field: TableFieldRow; config: TableFieldConfig & { relation: { targetTableId: number } } } =>
          isPositiveInteger(entry.config.relation?.targetTableId),
      );
    const targetTableIds = [...new Set(relationFields.map((entry) => entry.config.relation.targetTableId))];
    const targetRows =
      targetTableIds.length === 0
        ? []
        : await db
            .select({ id: tableRecords.id, table_id: tableRecords.table_id })
            .from(tableRecords)
            .where(and(inArray(tableRecords.table_id, targetTableIds), isNull(tableRecords.deleted_at)));
    const idsByTable = new Map<number, Set<number>>();
    for (const record of targetRows) {
      const ids = idsByTable.get(record.table_id) ?? new Set<number>();
      ids.add(record.id);
      idsByTable.set(record.table_id, ids);
    }
    const [table] = needsAttachments
      ? await db.select({ base_id: tableTables.base_id }).from(tableTables).where(eq(tableTables.id, tableId)).limit(1)
      : [];
    const attachmentFileIds =
      needsAttachments && table
        ? new Set(
            (
              await db
                .select({ id: driveFiles.id })
                .from(driveFiles)
                .where(
                  and(
                    eq(driveFiles.scope, 'tables'),
                    eq(driveFiles.base_id, table.base_id),
                    eq(driveFiles.status, 'active'),
                  ),
                )
            ).map((file) => file.id),
          )
        : new Set<number>();
    return {
      fields,
      byId: new Map(fields.map((field) => [String(field.id), field])),
      activeUserIds,
      relationTargets: new Map(
        relationFields.map(({ field, config }) => [
          String(field.id),
          idsByTable.get(config.relation.targetTableId) ?? new Set<number>(),
        ]),
      ),
      attachmentFileIds,
    };
  };

  const syncRecordEdges = async (
    tx: TablesExecutor,
    recordId: number,
    values: TableRecordValues,
    fields: TableFieldRow[],
    userId: string,
  ): Promise<void> => {
    await tx.delete(tableRecordLinks).where(eq(tableRecordLinks.source_record_id, recordId));
    await tx.delete(tableRecordAttachments).where(eq(tableRecordAttachments.record_id, recordId));
    const now = nowIso();
    const links: Array<typeof tableRecordLinks.$inferInsert> = [];
    const attachments: Array<typeof tableRecordAttachments.$inferInsert> = [];
    for (const field of fields) {
      const value = values[String(field.id)];
      if (field.type === 'relation') {
        const ids = Array.isArray(value) ? value : typeof value === 'number' ? [value] : [];
        ids.forEach((targetRecordId, position) => {
          if (typeof targetRecordId !== 'number') return;
          links.push({
            field_id: field.id,
            source_record_id: recordId,
            target_record_id: targetRecordId,
            position,
            created_by: userId,
            created_at: now,
          });
        });
      } else if (field.type === 'attachment' && Array.isArray(value)) {
        value.forEach((driveFileId, position) => {
          if (typeof driveFileId !== 'number') return;
          attachments.push({
            record_id: recordId,
            field_id: field.id,
            drive_file_id: driveFileId,
            position,
            created_by: userId,
            created_at: now,
          });
        });
      }
    }
    if (links.length > 0) await tx.insert(tableRecordLinks).values(links);
    if (attachments.length > 0) await tx.insert(tableRecordAttachments).values(attachments);
  };

  /**
   * What a scoped writer may put into relation and attachment fields, beyond
   * "exists in this Base" (which `validateValuesWithContext` already checks
   * for everyone). Only values new to the field count — ids already in the
   * record's current value of the same field (`previous`) stay accepted, so
   * editing an unrelated field never trips over a link someone else made.
   *
   * - D14: a new relation id must be a live record inside the writer's read
   *   rows on the target table (`scope.relationTargets`); a target table the
   *   role cannot see accepts nothing. Otherwise "change the link, then read
   *   the lookup" would read hidden rows.
   * - D15: a new attachment id must be the writer's own upload that is not on
   *   any other record. Otherwise copying another record's file id onto an
   *   own record would make it downloadable.
   *
   * Refusals read exactly like the generic "unavailable" ones, so they cannot
   * tell a hidden record or file from a missing one. Full scopes (built-in
   * roles, automations, imports) skip this: they read every row and file.
   */
  const assertScopedWriteTargets = async (
    executor: TablesExecutor,
    input: {
      scope: TableAccessScope;
      context: TableValidationContext;
      recordId: number | null;
      values: TableRecordValues;
      previous: TableRecordValues | null;
    },
  ): Promise<void> => {
    const { scope, context, recordId, values, previous } = input;
    if (scope.kind !== 'scoped') return;
    const asIds = (value: unknown): number[] =>
      (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]).filter(
        (entry): entry is number => typeof entry === 'number',
      );
    for (const [key, value] of Object.entries(values)) {
      const field = context.byId.get(key);
      if (!field || (field.type !== 'relation' && field.type !== 'attachment')) continue;
      const before = new Set(asIds(previous?.[key]));
      const added = [...new Set(asIds(value))].filter((id) => !before.has(id));
      if (added.length === 0) continue;

      if (field.type === 'relation') {
        const targetTableId = parseTableFieldConfig(field).relation?.targetTableId;
        const target = scope.relationTargets?.find((entry) => entry.tableId === targetTableId);
        const unavailable = new TablesValidationError(`Field "${field.name}" references an unavailable record`);
        if (!targetTableId || !target) throw unavailable;
        const targetScope: TableAccessScope = {
          kind: 'scoped',
          userId: scope.userId,
          tableId: targetTableId,
          rows: target.rows,
          editRows: [],
          readableFieldIds: [],
          editableFieldIds: [],
          canCreate: false,
          canDelete: false,
        };
        const predicate = scopeRowPredicate(
          targetScope,
          await loadCompileContext(executor, targetTableId, targetScope),
          'read',
        );
        const reachable = await executor
          .select({ id: tableRecords.id })
          .from(tableRecords)
          .where(
            and(
              eq(tableRecords.table_id, targetTableId),
              inArray(tableRecords.id, added),
              isNull(tableRecords.deleted_at),
              predicate,
            ),
          );
        if (reachable.length !== added.length) throw unavailable;
        continue;
      }

      const unavailable = new TablesValidationError(`Field "${field.name}" references an unavailable Base file`);
      const [own, attachedElsewhere] = await Promise.all([
        executor
          .select({ id: driveFiles.id })
          .from(driveFiles)
          .where(
            and(
              inArray(driveFiles.id, added),
              eq(driveFiles.scope, 'tables'),
              eq(driveFiles.status, 'active'),
              eq(driveFiles.uploaded_by, scope.userId),
            ),
          ),
        executor
          .select({ id: tableRecordAttachments.drive_file_id })
          .from(tableRecordAttachments)
          .where(
            and(
              inArray(tableRecordAttachments.drive_file_id, added),
              recordId === null ? undefined : ne(tableRecordAttachments.record_id, recordId),
            ),
          )
          .limit(1),
      ]);
      if (own.length !== added.length || attachedElsewhere.length > 0) throw unavailable;
    }
  };

  /** The scope's row predicate on `tableId` (undefined = unrestricted). */
  const rowPredicate = async (
    tableId: number,
    scope: TableAccessScope,
    purpose: 'read' | 'edit',
  ): Promise<SQL | undefined> => {
    if (scope.kind === 'full') return undefined;
    return scopeRowPredicate(scope, await loadCompileContext(db, tableId, scope), purpose);
  };

  const assertScopedTable = (scope: TableAccessScope, tableId: number): void => {
    assertScope(scope);
    assertScopeForTable(scope, tableId);
  };

  const createRecordWithContext = async (
    input: CreateTableRecordInput,
    context: TableValidationContext,
    scope: TableAccessScope,
    meta: TableRecordWriteMeta,
    hooks: RecordWriteHooks = {},
  ): Promise<TableRecordRow> => {
    assertScopedTable(scope, input.table_id);
    assertWriteMeta(meta);
    if (scope.kind === 'scoped' && !scope.canCreate) {
      throw new TablesValidationError('Creating records is not allowed', 'create_forbidden');
    }
    assertEditableKeys(scope, input.values);
    const values = validateValuesWithContext(context, input.values, { requireAll: true, scope });
    return db.transaction(async (tx) => {
      await assertScopedWriteTargets(tx, { scope, context, recordId: null, values, previous: null });
      const now = nowIso();
      const computed = await compute.computeRecordValues(tx, input.table_id, values);
      const [created] = await tx
        .insert(tableRecords)
        .values({
          table_id: input.table_id,
          values,
          computed_values: computed,
          computed_at: now,
          revision: 1,
          created_by: meta.actorId,
          updated_by: meta.actorId,
          created_at: now,
          updated_at: now,
        })
        .returning();
      await syncRecordEdges(tx, created!.id, values, context.fields, meta.actorId);
      await onRecordWritten(tx, {
        kind: 'created',
        tableId: input.table_id,
        recordId: created!.id,
        revision: created!.revision,
        before: null,
        after: recordSnapshot(created!),
        meta,
      });
      if (hooks.inTransaction) await hooks.inTransaction(tx, created!);
      return created!;
    });
  };

  const updateRecordWithContext = async (
    input: UpdateTableRecordInput,
    context: TableValidationContext,
    scope: TableAccessScope,
    meta: TableRecordWriteMeta,
  ): Promise<TableRecordWriteResult> => {
    assertScopedTable(scope, input.table_id);
    assertWriteMeta(meta);
    assertEditableKeys(scope, input.values);
    const predicate = await rowPredicate(input.table_id, scope, 'edit');
    const outcome = await db.transaction(async (tx): Promise<TableRecordWriteResult> => {
      const [current] = await tx
        .select()
        .from(tableRecords)
        .where(
          and(
            eq(tableRecords.table_id, input.table_id),
            eq(tableRecords.id, input.record_id),
            isNull(tableRecords.deleted_at),
            predicate,
          ),
        )
        .limit(1)
        .for('update');
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.revision !== input.revision) return { ok: false, reason: 'conflict', current: current.revision };
      const patch = validateValuesWithContext(context, input.values, { requireAll: false, scope });
      const values = validateValuesWithContext(context, { ...current.values, ...patch }, { requireAll: true, scope });
      await assertScopedWriteTargets(tx, {
        scope,
        context,
        recordId: current.id,
        values: patch,
        previous: current.values,
      });
      const now = nowIso();
      const computed = await compute.computeRecordValues(tx, input.table_id, values);
      const [updated] = await tx
        .update(tableRecords)
        .set({
          values,
          computed_values: computed,
          computed_revision: current.computed_revision + 1,
          computed_at: now,
          revision: current.revision + 1,
          updated_by: meta.actorId,
          updated_at: now,
        })
        .where(and(eq(tableRecords.id, current.id), eq(tableRecords.revision, current.revision)))
        .returning();
      await syncRecordEdges(tx, updated!.id, values, context.fields, meta.actorId);
      await onRecordWritten(tx, {
        kind: 'updated',
        tableId: input.table_id,
        recordId: updated!.id,
        revision: updated!.revision,
        before: recordSnapshot(current),
        after: recordSnapshot(updated!),
        meta,
      });
      return { ok: true, record: updated! };
    });
    if (outcome.ok) await compute.refreshDependentRollups(outcome.record.table_id, outcome.record.id);
    return outcome;
  };

  /** Create with a fresh validation context, then (after commit) the legacy automation pass. */
  const createRecord = async (
    input: CreateTableRecordInput,
    scope: TableAccessScope,
    meta: TableRecordWriteMeta,
    hooks: RecordWriteHooks = {},
  ): Promise<TableRecordRow> => {
    const record = await createRecordWithContext(
      input,
      await loadValidationContext(input.table_id),
      scope,
      meta,
      hooks,
    );
    if (meta.enqueueAutomations) await deps.afterCommit('record_created', record, meta);
    return record;
  };

  const service = {
    async activeInternalUserIds(): Promise<Set<string>> {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.status, 'active'), inArray(users.role, ['team', 'super'])));
      return new Set(rows.map((row) => row.id));
    },

    async createRecord(
      input: CreateTableRecordInput,
      scope: TableAccessScope,
      meta: TableRecordWriteMeta,
    ): Promise<TableRecordRow> {
      return createRecord(input, scope, meta);
    },

    /** One live record the scope may read (full row — project it for scoped readers). */
    async getRecord(tableId: number, recordId: number, scope: TableAccessScope): Promise<TableRecordRow | undefined> {
      assertScopedTable(scope, tableId);
      const predicate = await rowPredicate(tableId, scope, 'read');
      const rows = await db
        .select()
        .from(tableRecords)
        .where(
          and(
            eq(tableRecords.table_id, tableId),
            eq(tableRecords.id, recordId),
            isNull(tableRecords.deleted_at),
            predicate,
          ),
        )
        .limit(1);
      return rows[0];
    },

    /**
     * Ownership lookup only (audit, resolving a record's Base): no scope and no
     * `deleted_at` filter. Never return its result to a client.
     */
    async getRecordById(recordId: number): Promise<TableRecordRow | undefined> {
      const rows = await db.select().from(tableRecords).where(eq(tableRecords.id, recordId)).limit(1);
      return rows[0];
    },

    async listRecordLinks(fieldId: number, sourceRecordId: number): Promise<TableRecordLinkRow[]> {
      return db
        .select()
        .from(tableRecordLinks)
        .where(and(eq(tableRecordLinks.field_id, fieldId), eq(tableRecordLinks.source_record_id, sourceRecordId)))
        .orderBy(asc(tableRecordLinks.position));
    },

    async listRecordAttachments(recordId: number, fieldId: number): Promise<TableRecordAttachmentRow[]> {
      return db
        .select()
        .from(tableRecordAttachments)
        .where(and(eq(tableRecordAttachments.record_id, recordId), eq(tableRecordAttachments.field_id, fieldId)))
        .orderBy(asc(tableRecordAttachments.position));
    },

    async listRecomputeJobs(recordId: number): Promise<TableRecomputeJobRow[]> {
      return db
        .select()
        .from(tableRecomputeJobs)
        .where(eq(tableRecomputeJobs.record_id, recordId))
        .orderBy(desc(tableRecomputeJobs.created_at));
    },

    async updateRecord(
      input: UpdateTableRecordInput,
      scope: TableAccessScope,
      meta: TableRecordWriteMeta,
    ): Promise<TableRecordWriteResult> {
      const result = await updateRecordWithContext(input, await loadValidationContext(input.table_id), scope, meta);
      if (result.ok && meta.enqueueAutomations) await deps.afterCommit('record_updated', result.record, meta);
      return result;
    },

    async deleteRecord(
      input: DeleteTableRecordInput,
      scope: TableAccessScope,
      meta: TableRecordWriteMeta,
    ): Promise<TableRecordWriteResult> {
      assertScopedTable(scope, input.table_id);
      assertWriteMeta(meta);
      if (scope.kind === 'scoped' && !scope.canDelete) {
        throw new TablesValidationError('Deleting records is not allowed', 'delete_forbidden');
      }
      const predicate = await rowPredicate(input.table_id, scope, 'edit');
      const outcome = await db.transaction(async (tx): Promise<TableRecordWriteResult> => {
        const [current] = await tx
          .select()
          .from(tableRecords)
          .where(
            and(
              eq(tableRecords.table_id, input.table_id),
              eq(tableRecords.id, input.record_id),
              isNull(tableRecords.deleted_at),
              predicate,
            ),
          )
          .limit(1)
          .for('update');
        if (!current) return { ok: false, reason: 'not_found' };
        if (current.revision !== input.revision) return { ok: false, reason: 'conflict', current: current.revision };
        const now = nowIso();
        const [deleted] = await tx
          .update(tableRecords)
          .set({ deleted_at: now, updated_at: now, updated_by: meta.actorId, revision: current.revision + 1 })
          .where(and(eq(tableRecords.id, current.id), eq(tableRecords.revision, current.revision)))
          .returning();
        await onRecordWritten(tx, {
          kind: 'deleted',
          tableId: input.table_id,
          recordId: deleted!.id,
          revision: deleted!.revision,
          before: recordSnapshot(current),
          after: null,
          meta,
        });
        return { ok: true, record: deleted! };
      });
      if (outcome.ok) await compute.refreshDependentRollups(outcome.record.table_id, outcome.record.id);
      return outcome;
    },

    /**
     * The recycle bin feed. Deliberately not part of the bounded record query
     * AST: deleted rows are a maintenance view, not data anyone should filter,
     * sort or hand to an agent.
     */
    async listDeletedRecords(tableId: number, scope: TableAccessScope, limit = 100): Promise<TableRecordRow[]> {
      assertScopedTable(scope, tableId);
      const predicate = await rowPredicate(tableId, scope, 'read');
      return db
        .select()
        .from(tableRecords)
        .where(and(eq(tableRecords.table_id, tableId), isNotNull(tableRecords.deleted_at), predicate))
        .orderBy(desc(tableRecords.updated_at))
        .limit(Math.min(Math.max(limit, 1), 200));
    },

    /** Undo a delete. Bumps the revision like delete does; scoped callers need delete rights. */
    async restoreRecord(
      input: RestoreTableRecordInput,
      scope: TableAccessScope,
      meta: TableRecordWriteMeta,
    ): Promise<{ ok: true; record: TableRecordRow } | { ok: false; reason: 'not_found' }> {
      assertScopedTable(scope, input.table_id);
      assertWriteMeta(meta);
      if (scope.kind === 'scoped' && !scope.canDelete) {
        throw new TablesValidationError('Restoring records is not allowed', 'delete_forbidden');
      }
      const predicate = await rowPredicate(input.table_id, scope, 'edit');
      const restored = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(tableRecords)
          .where(
            and(
              eq(tableRecords.table_id, input.table_id),
              eq(tableRecords.id, input.record_id),
              isNotNull(tableRecords.deleted_at),
              predicate,
            ),
          )
          .limit(1)
          .for('update');
        if (!current) return undefined;
        const [row] = await tx
          .update(tableRecords)
          .set({ deleted_at: null, updated_at: nowIso(), updated_by: meta.actorId, revision: current.revision + 1 })
          .where(eq(tableRecords.id, current.id))
          .returning();
        await onRecordWritten(tx, {
          kind: 'restored',
          tableId: input.table_id,
          recordId: row!.id,
          revision: row!.revision,
          before: null,
          after: recordSnapshot(row!),
          meta,
        });
        return row;
      });
      if (!restored) return { ok: false, reason: 'not_found' };
      await compute.refreshDependentRollups(restored.table_id, restored.id);
      return { ok: true, record: restored };
    },

    async recordQueryParts(
      tableId: number,
      query: TableQuery,
      scope: TableAccessScope,
      evaluation?: TableQueryEvaluation,
    ): Promise<TableRecordQueryParts> {
      assertScope(scope);
      return compileRecordQuery(query, scope, await loadCompileContext(db, tableId, scope, evaluation));
    },

    async queryRecords(
      tableId: number,
      query: TableQuery,
      scope: TableAccessScope,
      evaluation?: TableQueryEvaluation,
    ): Promise<TableRecordQueryResult> {
      const parts = await service.recordQueryParts(tableId, query, scope, evaluation);
      const [records, countRows] = await Promise.all([
        db
          .select()
          .from(tableRecords)
          .where(parts.where)
          .orderBy(...parts.order)
          .limit(parts.limit)
          .offset(parts.offset),
        db
          .select({ count: sql<number>`count(*)` })
          .from(tableRecords)
          .where(parts.where),
      ]);
      const total = Number(countRows[0]?.count ?? 0);
      const nextOffset = parts.offset + records.length;
      return {
        records,
        total,
        nextCursor: nextOffset < total ? encodeCursor(nextOffset, parts.fingerprint) : null,
      };
    },

    async validateBatchRecords(
      input: { table_id: number; items: BatchUpsertTableRecordItem[] },
      scope: TableAccessScope,
    ): Promise<TableBatchValidationResult[]> {
      assertScopedTable(scope, input.table_id);
      if (input.items.length < 1 || input.items.length > MAX_BATCH_RECORDS) {
        throw new TablesValidationError(`batch supports 1-${MAX_BATCH_RECORDS} records`);
      }
      const context = await loadValidationContext(input.table_id);
      const recordIds = [
        ...new Set(
          input.items
            .map((item) => item.record_id)
            .filter((recordId): recordId is number => typeof recordId === 'number'),
        ),
      ];
      const predicate = await rowPredicate(input.table_id, scope, 'edit');
      const existing =
        recordIds.length === 0
          ? []
          : await db
              .select()
              .from(tableRecords)
              .where(
                and(
                  eq(tableRecords.table_id, input.table_id),
                  inArray(tableRecords.id, recordIds),
                  isNull(tableRecords.deleted_at),
                  predicate,
                ),
              );
      const byRecordId = new Map(existing.map((record) => [record.id, record]));
      const results: TableBatchValidationResult[] = [];
      for (const [index, item] of input.items.entries()) {
        try {
          if (item.record_id == null) {
            if (scope.kind === 'scoped' && !scope.canCreate) {
              throw new TablesValidationError('Creating records is not allowed', 'create_forbidden');
            }
            assertEditableKeys(scope, item.values);
            const values = validateValuesWithContext(context, item.values, { requireAll: true, scope });
            await assertScopedWriteTargets(db, { scope, context, recordId: null, values, previous: null });
            results.push({ index, ok: true });
            continue;
          }
          const current = byRecordId.get(item.record_id);
          if (!current) {
            results.push({ index, ok: false, reason: 'not_found' });
            continue;
          }
          if (!item.revision) {
            results.push({ index, ok: false, reason: 'invalid', message: 'revision is required' });
            continue;
          }
          if (current.revision !== item.revision) {
            results.push({ index, ok: false, reason: 'conflict', current: current.revision });
            continue;
          }
          assertEditableKeys(scope, item.values);
          const patch = validateValuesWithContext(context, item.values, { requireAll: false, scope });
          validateValuesWithContext(context, { ...current.values, ...patch }, { requireAll: true, scope });
          await assertScopedWriteTargets(db, {
            scope,
            context,
            recordId: current.id,
            values: patch,
            previous: current.values,
          });
          results.push({ index, ok: true });
        } catch (error) {
          results.push({
            index,
            ok: false,
            reason: 'invalid',
            message: error instanceof Error ? error.message : 'Invalid record',
          });
        }
      }
      return results;
    },

    /**
     * Where a Drive file is attached: one row per (record, field), with the
     * record's table and whether it is in the recycle bin. Drive's per-file
     * checks (`canReadTablesFile`, deleting an unattached upload) read this.
     */
    async listFileAttachments(
      driveFileId: number,
    ): Promise<Array<{ record_id: number; field_id: number; table_id: number; deleted: boolean }>> {
      const rows = await db
        .select({
          record_id: tableRecordAttachments.record_id,
          field_id: tableRecordAttachments.field_id,
          table_id: tableRecords.table_id,
          deleted_at: tableRecords.deleted_at,
        })
        .from(tableRecordAttachments)
        .innerJoin(tableRecords, eq(tableRecords.id, tableRecordAttachments.record_id))
        .where(eq(tableRecordAttachments.drive_file_id, driveFileId));
      return rows.map(({ deleted_at, ...row }) => ({ ...row, deleted: deleted_at !== null }));
    },

    async batchUpsertRecords(
      input: { table_id: number; items: BatchUpsertTableRecordItem[] },
      scope: TableAccessScope,
      meta: TableRecordWriteMeta,
    ): Promise<TableBatchUpsertResult[]> {
      assertScopedTable(scope, input.table_id);
      assertWriteMeta(meta);
      if (input.items.length < 1 || input.items.length > MAX_BATCH_RECORDS) {
        throw new TablesValidationError(`batch supports 1-${MAX_BATCH_RECORDS} records`);
      }
      const context = await loadValidationContext(input.table_id);
      const results: TableBatchUpsertResult[] = [];
      for (const [index, item] of input.items.entries()) {
        try {
          if (item.record_id == null) {
            const record = await createRecordWithContext(
              { table_id: input.table_id, values: item.values },
              context,
              scope,
              meta,
            );
            if (meta.enqueueAutomations) await deps.afterCommit('record_created', record, meta);
            results.push({ index, ok: true, record });
            continue;
          }
          if (!item.revision) {
            results.push({ index, ok: false, reason: 'invalid', message: 'revision is required' });
            continue;
          }
          const result = await updateRecordWithContext(
            { table_id: input.table_id, record_id: item.record_id, revision: item.revision, values: item.values },
            context,
            scope,
            meta,
          );
          if (result.ok && meta.enqueueAutomations) await deps.afterCommit('record_updated', result.record, meta);
          results.push(result.ok ? { index, ok: true, record: result.record } : { index, ...result });
        } catch (error) {
          results.push({
            index,
            ok: false,
            reason: 'invalid',
            message: error instanceof Error ? error.message : 'Invalid record',
          });
        }
      }
      return results;
    },
  };

  return {
    service,
    /** Write internals shared with forms and the automation executor. */
    internal: { loadValidationContext, createRecord, createRecordWithContext, updateRecordWithContext },
  };
}

export type TablesRecordInternals = ReturnType<typeof createTablesRecords>['internal'];
