/**
 * CSV / Excel imports — the staged rows of one upload and the lifecycle that
 * turns them into records exactly once.
 *
 *   previewed ──commit (CAS)──▶ committing ──last chunk──▶ committed
 *                                   │  ▲
 *                                   │  └─ lease released or expired: the next commit call resumes
 *                                   └──▶ failed (the stored plan cannot be carried out)
 *
 * - One upload is one row. It belongs to its uploader and its table and lives
 *   for an hour after its last activity (`expires_at`); `sweepExpiredImports`
 *   deletes it after that. Completion clears `rows`.
 * - A commit claims the row with a short lease. The plan it decided (mapping,
 *   created field ids, header flag, zone) is stored at the claim, so a resumed
 *   commit carries on with the same plan instead of deciding again.
 * - Rows are written in chunks; each chunk's records and the `committed_rows`
 *   counter commit in one transaction, guarded by compare-and-set on that
 *   counter. A crashed, retried or doubled commit therefore never writes a row
 *   twice: the loser's chunk rolls back whole.
 * - Writes carry `actorKind: 'import'`, `source.importId` and never enqueue
 *   automations (spec D6) — refused here, not left to callers.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type {
  TableFieldType,
  TableImportResult,
  TableRecordValues,
  TableRecordWriteMeta,
} from '@greenhouse/types/tables';
import type { TableAccessScope } from '@greenhouse/types/table-access';
import type { Db } from '../../client.js';
import { tableImports, tableRecords } from '../../schema/index.js';
import type { TableImportRow, TableRecordRow } from '../../schema/tables.js';
import { assertScopeForTable, loadCompileContext, recordFieldText, scopeRowPredicate } from './query.js';
import type { TablesRecordInternals } from './records.js';
import { assertScope, assertWriteMeta, TablesValidationError } from './shared.js';

export const TABLE_IMPORT_MAX_ROWS = 10_000;
export const TABLE_IMPORT_MAX_COLUMNS = 100;
/** Rows written per transaction. */
export const TABLE_IMPORT_CHUNK_ROWS = 100;
/** Failed rows kept in the result (the count keeps going). */
export const TABLE_IMPORT_MAX_FAILURES = 100;
const IMPORT_TTL_MS = 60 * 60 * 1000;
const IMPORT_LEASE_MS = 60 * 1000;
const MAX_CELL_CHARS = 100_000;

/** One column's destination, decided when the commit starts. */
export interface TableImportPlanColumn {
  column: number;
  /** The field it fills (set for new fields once created). */
  fieldId?: number;
  /** A field the import creates. */
  create?: { name: string; type: TableFieldType };
}

/** What a commit decided, stored at the claim so a resumed commit reuses it. */
export interface TableImportPlan {
  columns: TableImportPlanColumn[];
  hasHeader: boolean;
  createOptions: boolean;
  timeZone: string;
}

/** The `result` column: the running result, plus the plan and a terminal error. */
interface StoredImportState extends TableImportResult {
  plan?: TableImportPlan;
  error?: string;
}

export interface CreateTableImportInput {
  table_id: number;
  user_id: string;
  file_name: string;
  header: string[];
  rows: string[][];
}

export type TableImportClaim =
  | { ok: true; import: TableImportRow; plan: TableImportPlan; resumed: boolean }
  | { ok: false; reason: 'not_found' | 'expired' | 'busy' | 'committed' | 'failed'; import?: TableImportRow };

/** One file row of a chunk: values to write, or the reasons it was refused before writing. */
export interface TableImportChunkItem {
  /** The row number shown to the user. */
  row: number;
  values?: TableRecordValues;
  errors?: string[];
}

export type TableImportChunkResult =
  | {
      ok: true;
      created: TableRecordRow[];
      failed: TableImportResult['failed'];
      committedRows: number;
      result: TableImportResult;
    }
  /** Another commit moved the import on (or it is no longer committing): nothing was written. */
  | { ok: false; reason: 'moved' };

const NUL = String.fromCharCode(0);

function clean(text: string): string {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.includes(NUL) ? value.replaceAll(NUL, '') : value;
}

function emptyState(): StoredImportState {
  return { created: 0, failed: [], failedCount: 0, createdFieldIds: [] };
}

function storedState(row: Pick<TableImportRow, 'result'>): StoredImportState {
  const state = row.result as StoredImportState | null;
  return state && typeof state === 'object' ? { ...emptyState(), ...state } : emptyState();
}

/** The public part of the stored state (never the plan). */
export function tableImportResult(row: Pick<TableImportRow, 'result'>): TableImportResult {
  const state = storedState(row);
  return {
    created: state.created,
    failed: state.failed,
    failedCount: state.failedCount ?? state.failed.length,
    createdFieldIds: state.createdFieldIds,
  };
}

export function tableImportPlan(row: Pick<TableImportRow, 'result'>): TableImportPlan | undefined {
  return storedState(row).plan;
}

export function tableImportError(row: Pick<TableImportRow, 'result'>): string | undefined {
  return storedState(row).error;
}

/** The rows a plan imports: the header row is data when the file has none. */
export function tableImportDataRows(row: Pick<TableImportRow, 'header' | 'rows'>, hasHeader: boolean): string[][] {
  return hasHeader ? row.rows : [row.header, ...row.rows];
}

/** File row number (1-based, counting the header line) of data row `index`. */
export function tableImportRowNumber(index: number, hasHeader: boolean): number {
  return index + (hasHeader ? 2 : 1);
}

function inFuture(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export function createTablesImports(db: Db, deps: { records: TablesRecordInternals }) {
  const isExpired = (row: Pick<TableImportRow, 'expires_at'>) => Date.parse(row.expires_at) <= Date.now();
  const leaseHeld = (row: Pick<TableImportRow, 'lease_expires_at'>) =>
    row.lease_expires_at !== null && Date.parse(row.lease_expires_at) > Date.now();

  const service = {
    /** Stage an upload. Cells are capped and NUL-free; the first row is the header. */
    async createImport(input: CreateTableImportInput): Promise<TableImportRow> {
      if (input.rows.length > TABLE_IMPORT_MAX_ROWS) {
        throw new TablesValidationError(`An import supports at most ${TABLE_IMPORT_MAX_ROWS} rows`);
      }
      const width = Math.max(input.header.length, ...input.rows.map((row) => row.length));
      if (width > TABLE_IMPORT_MAX_COLUMNS) {
        throw new TablesValidationError(`An import supports at most ${TABLE_IMPORT_MAX_COLUMNS} columns`);
      }
      const cell = (value: string) => clean(value).slice(0, MAX_CELL_CHARS);
      const now = new Date();
      const [row] = await db
        .insert(tableImports)
        .values({
          id: `imp_${randomUUID().replaceAll('-', '')}`,
          table_id: input.table_id,
          user_id: input.user_id,
          file_name: clean(input.file_name).slice(0, 255) || 'import',
          header: input.header.map(cell),
          rows: input.rows.map((row) => row.map(cell)),
          status: 'previewed',
          committed_rows: 0,
          result: emptyState(),
          created_at: now.toISOString(),
          expires_at: new Date(now.getTime() + IMPORT_TTL_MS).toISOString(),
        })
        .returning();
      return row!;
    },

    async getImport(id: string): Promise<TableImportRow | undefined> {
      const rows = await db.select().from(tableImports).where(eq(tableImports.id, id)).limit(1);
      return rows[0];
    },

    /**
     * Start or resume a commit. A fresh import (`previewed`, not expired) stores
     * `plan`; a `committing` one whose lease is free resumes with its stored plan.
     * Another live lease is `busy`; finished imports report their state.
     */
    async claimImport(input: {
      importId: string;
      userId: string;
      tableId: number;
      plan: TableImportPlan;
    }): Promise<TableImportClaim> {
      return db.transaction(async (tx): Promise<TableImportClaim> => {
        const [row] = await tx
          .select()
          .from(tableImports)
          .where(eq(tableImports.id, input.importId))
          .limit(1)
          .for('update');
        if (!row || row.user_id !== input.userId || row.table_id !== input.tableId) {
          return { ok: false, reason: 'not_found' };
        }
        if (row.status === 'committed') return { ok: false, reason: 'committed', import: row };
        if (row.status === 'failed') return { ok: false, reason: 'failed', import: row };
        if (row.status === 'committing' && leaseHeld(row)) return { ok: false, reason: 'busy', import: row };
        if (isExpired(row)) return { ok: false, reason: 'expired', import: row };

        const resumed = row.status === 'committing';
        const state = storedState(row);
        const plan = resumed && state.plan ? state.plan : input.plan;
        const result: StoredImportState = { ...state, plan };
        const [claimed] = await tx
          .update(tableImports)
          .set({
            status: 'committing',
            lease_expires_at: inFuture(IMPORT_LEASE_MS),
            expires_at: inFuture(IMPORT_TTL_MS),
            result,
          })
          .where(eq(tableImports.id, row.id))
          .returning();
        return { ok: true, import: claimed!, plan, resumed };
      });
    },

    /** Persist the plan as it resolves (a created field's id), while the commit still holds the import. */
    async saveImportPlan(importId: string, plan: TableImportPlan, createdFieldIds: number[]): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(tableImports).where(eq(tableImports.id, importId)).limit(1).for('update');
        if (!row || row.status !== 'committing') return false;
        const result: StoredImportState = { ...storedState(row), plan, createdFieldIds };
        await tx
          .update(tableImports)
          .set({ result, lease_expires_at: inFuture(IMPORT_LEASE_MS) })
          .where(eq(tableImports.id, importId));
        return true;
      });
    },

    /**
     * Write one chunk: every item's record (or its refusal) and the progress
     * counter, in one transaction that only proceeds when the import is still
     * committing at `fromRow`. Validation refusals become failed rows; anything
     * else rolls the whole chunk back.
     */
    async commitImportChunk(
      input: { importId: string; tableId: number; fromRow: number; items: TableImportChunkItem[] },
      scope: TableAccessScope,
      meta: TableRecordWriteMeta,
    ): Promise<TableImportChunkResult> {
      assertScope(scope);
      assertScopeForTable(scope, input.tableId);
      assertWriteMeta(meta);
      if (meta.actorKind !== 'import' || meta.enqueueAutomations || meta.source?.importId !== input.importId) {
        throw new TablesValidationError('Import writes need import write meta without automations');
      }
      if (input.items.length > TABLE_IMPORT_CHUNK_ROWS) {
        throw new TablesValidationError(`An import chunk holds at most ${TABLE_IMPORT_CHUNK_ROWS} rows`);
      }
      const context = await deps.records.loadValidationContext(input.tableId);
      return db.transaction(async (tx): Promise<TableImportChunkResult> => {
        const [row] = await tx
          .select()
          .from(tableImports)
          .where(eq(tableImports.id, input.importId))
          .limit(1)
          .for('update');
        if (
          !row ||
          row.table_id !== input.tableId ||
          row.status !== 'committing' ||
          row.committed_rows !== input.fromRow
        ) {
          return { ok: false, reason: 'moved' };
        }
        const created: TableRecordRow[] = [];
        const failed: TableImportResult['failed'] = [];
        for (const item of input.items) {
          if (item.errors && item.errors.length > 0) {
            failed.push({ row: item.row, errors: item.errors });
            continue;
          }
          try {
            created.push(
              await deps.records.createRecordWithContext(
                { table_id: input.tableId, values: item.values ?? {} },
                context,
                scope,
                meta,
                { within: tx },
              ),
            );
          } catch (error) {
            if (!(error instanceof TablesValidationError)) throw error;
            failed.push({ row: item.row, errors: [error.message] });
          }
        }
        const state = storedState(row);
        const next: StoredImportState = {
          ...state,
          created: state.created + created.length,
          failed: [...state.failed, ...failed].slice(0, TABLE_IMPORT_MAX_FAILURES),
          failedCount: (state.failedCount ?? state.failed.length) + failed.length,
        };
        const committedRows = input.fromRow + input.items.length;
        await tx
          .update(tableImports)
          .set({
            committed_rows: committedRows,
            result: next,
            lease_expires_at: inFuture(IMPORT_LEASE_MS),
            expires_at: inFuture(IMPORT_TTL_MS),
          })
          .where(eq(tableImports.id, row.id));
        return { ok: true, created, failed, committedRows, result: tableImportResult({ result: next }) };
      });
    },

    /** Let the next commit call continue (the caller stopped on its time budget or an error). */
    async releaseImportLease(importId: string): Promise<void> {
      await db
        .update(tableImports)
        .set({ lease_expires_at: null })
        .where(and(eq(tableImports.id, importId), eq(tableImports.status, 'committing')));
    },

    /** Every row is written: keep the result, drop the staged rows. */
    async completeImport(importId: string): Promise<TableImportRow | undefined> {
      const rows = await db
        .update(tableImports)
        .set({ status: 'committed', rows: [], lease_expires_at: null, expires_at: inFuture(IMPORT_TTL_MS) })
        .where(and(eq(tableImports.id, importId), eq(tableImports.status, 'committing')))
        .returning();
      return rows[0];
    },

    /** The stored plan cannot be carried out (e.g. a column's new field could not be created). */
    async failImport(importId: string, message: string): Promise<TableImportRow | undefined> {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(tableImports).where(eq(tableImports.id, importId)).limit(1).for('update');
        if (!row || row.status !== 'committing') return undefined;
        const result: StoredImportState = { ...storedState(row), error: message.slice(0, 500) };
        const [failed] = await tx
          .update(tableImports)
          .set({ status: 'failed', rows: [], lease_expires_at: null, result })
          .where(eq(tableImports.id, importId))
          .returning();
        return failed;
      });
    },

    /** Upkeep: delete imports past their expiry, except one a commit is holding right now. */
    async sweepExpiredImports(now: Date = new Date()): Promise<number> {
      const at = now.toISOString();
      const deleted = await db
        .delete(tableImports)
        .where(
          and(
            lt(tableImports.expires_at, at),
            or(
              sql`${tableImports.status} <> 'committing'`,
              isNull(tableImports.lease_expires_at),
              lt(tableImports.lease_expires_at, at),
            ),
          ),
        )
        .returning({ id: tableImports.id });
      return deleted.length;
    },

    /**
     * Relation matching for an import (D14): primary-field text → ids of the
     * live records on `tableId` that `scope` may read. A scoped reader who
     * cannot read the primary field matches nothing — matching would otherwise
     * reveal hidden values.
     */
    async matchImportRelationLabels(
      tableId: number,
      primaryFieldId: number,
      labels: readonly string[],
      scope: TableAccessScope,
    ): Promise<Map<string, number[]>> {
      assertScope(scope);
      const wanted = [...new Set(labels.filter((label) => label !== ''))];
      const matches = new Map<string, number[]>();
      if (wanted.length === 0) return matches;
      if (scope.kind === 'scoped' && !scope.readableFieldIds.includes(primaryFieldId)) return matches;
      const ctx = await loadCompileContext(db, tableId, scope);
      const primary = ctx.byId.get(primaryFieldId);
      if (!primary) return matches;
      const key = String(primary.id);
      const predicate = scopeRowPredicate(scope, ctx, 'read');
      for (let start = 0; start < wanted.length; start += 1_000) {
        const batch = wanted.slice(start, start + 1_000);
        const rows = await db
          .select({ id: tableRecords.id, label: sql<string>`${recordFieldText(key)}` })
          .from(tableRecords)
          .where(
            and(
              eq(tableRecords.table_id, tableId),
              isNull(tableRecords.deleted_at),
              inArray(recordFieldText(key), batch),
              predicate,
            ),
          );
        for (const row of rows) matches.set(row.label, [...(matches.get(row.label) ?? []), row.id]);
      }
      return matches;
    },
  };
  return service;
}

export type TablesImports = ReturnType<typeof createTablesImports>;
