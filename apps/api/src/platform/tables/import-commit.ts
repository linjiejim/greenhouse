/**
 * Tables import — carrying out a claimed commit (slice I).
 *
 * One call: create the plan's new fields and options (through runtime.dispatch,
 * so they are capability-checked and audited as `createField` / `updateField`;
 * a resume finds already-created fields by name and stores ids as it goes),
 * then write chunks of 100 rows until the time budget runs out, then complete
 * the import or release the lease for the next call. A chunk that another
 * runner beat to it is not an error — the caller reports where the import
 * stands.
 */

import {
  TABLE_IMPORT_CHUNK_ROWS,
  tableImportDataRows,
  tableImportError,
  tableImportPlan,
  tableImportResult,
  withImportedOptions,
  type ImportField,
  type TableFieldRow,
  type TableImportClaim,
  type TableImportRow,
} from '@greenhouse/db';
import type { TableImportProgress } from '@greenhouse/types/tables';
import type { TablesActionId } from '../manifests/tables.js';
import { getPlatformRuntime } from '../runtime.js';
import type { TableDataAccess } from './access.js';
import { tablesResource, type TablesResourceIds } from './audit.js';
import {
  columnSelectLabels,
  createdFieldConfig,
  importField,
  importRowItem,
  loadColumnContexts,
} from './import-plan.js';
import { publishRecordsChanged } from './realtime.js';
import { writeMeta, type Handler, type HandlerRequest } from './handlers/shared.js';

type Context = Parameters<Handler>[1];
type Claimed = Extract<TableImportClaim, { ok: true }>;

/** How long one commit call keeps writing before it hands back progress. */
const COMMIT_BUDGET_MS = 5_000;

/** Dispatch a structure action as the importing actor (its own capability check and audit). */
function dispatchAs(request: HandlerRequest, actionId: TablesActionId, payload: unknown, ids: TablesResourceIds) {
  return getPlatformRuntime().dispatch({
    actor: request.actor,
    appId: 'tables',
    actionId,
    payload,
    resource: tablesResource(actionId, ids),
  });
}

/** The wire view of an import's state; `plan` gives the header flag while rows are still staged. */
export function importProgressView(row: TableImportRow, plan = tableImportPlan(row)): TableImportProgress {
  const finished = row.status === 'committed' || row.status === 'failed';
  const totalRows = finished ? row.committed_rows : tableImportDataRows(row, plan?.hasHeader ?? true).length;
  const error = tableImportError(row);
  return {
    importId: row.id,
    status: row.status === 'previewed' ? 'committing' : row.status,
    totalRows,
    processedRows: row.committed_rows,
    result: tableImportResult(row),
    ...(error ? { error } : {}),
  };
}

/** Create the plan's new fields (once — a resume finds them by name) and add missing options. */
async function prepareStructure(
  request: HandlerRequest,
  context: Context,
  claim: Claimed,
  rows: string[][],
): Promise<string | undefined> {
  const { db } = context;
  const tableId = claim.import.table_id;
  const plan = claim.plan;
  const createdFieldIds = [...tableImportResult(claim.import).createdFieldIds];
  for (const column of plan.columns) {
    if (!column.create || column.fieldId) continue;
    const create = column.create;
    const existing = (await db.tables.listFields(tableId)).find((field) => field.name === create.name);
    let fieldId = existing && existing.type === create.type ? existing.id : undefined;
    if (!fieldId) {
      const result = await dispatchAs(
        request,
        'createField',
        { tableId, name: create.name, type: create.type, config: createdFieldConfig(create, rows, column.column) },
        { tableId },
      );
      if (!result.ok) return `Could not create the field "${create.name}": ${result.message}`;
      fieldId = (result.data as { field: TableFieldRow }).field.id;
    }
    column.fieldId = fieldId;
    if (!createdFieldIds.includes(fieldId)) createdFieldIds.push(fieldId);
    await db.tables.saveImportPlan(claim.import.id, plan, createdFieldIds);
  }

  if (!plan.createOptions) return undefined;
  const fields = new Map((await db.tables.listFields(tableId)).map((field) => [field.id, field]));
  for (const column of plan.columns) {
    const row = column.create ? undefined : fields.get(column.fieldId ?? 0);
    if (!row || (row.type !== 'single_select' && row.type !== 'multi_select')) continue;
    const field = importField(row);
    // Recomputed on every call, so a resumed commit adds nothing twice.
    const labels = columnSelectLabels(field, rows, column.column);
    if (labels.length === 0) continue;
    const options = withImportedOptions(field.config.options ?? [], labels);
    if (options.length === (field.config.options ?? []).length) continue;
    const result = await dispatchAs(
      request,
      'updateField',
      { fieldId: row.id, config: { ...field.config, options } },
      { fieldId: row.id },
    );
    if (!result.ok) return `Could not add options to "${row.name}": ${result.message}`;
  }
  return undefined;
}

/** Run one commit call for a claimed import; never throws on lost races, only on real errors. */
export async function runImportCommit(
  request: HandlerRequest,
  context: Context,
  data: TableDataAccess,
  claim: Claimed,
): Promise<TableImportProgress> {
  const { db } = context;
  const importId = claim.import.id;
  const tableId = claim.import.table_id;
  const plan = claim.plan;
  const rows = tableImportDataRows(claim.import, plan.hasHeader);

  const structureError = await prepareStructure(request, context, claim, rows);
  if (structureError) {
    const failed = await db.tables.failImport(importId, structureError);
    return importProgressView(failed ?? claim.import, plan);
  }
  const fields = new Map((await db.tables.listFields(tableId)).map((field) => [field.id, field]));
  const columns: Array<{ column: number; field: ImportField }> = [];
  for (const column of plan.columns) {
    const field = fields.get(column.fieldId ?? 0);
    if (!field) {
      const failed = await db.tables.failImport(importId, 'A mapped field was removed while the import ran');
      return importProgressView(failed ?? claim.import, plan);
    }
    columns.push({ column: column.column, field: importField(field) });
  }
  const contexts = await loadColumnContexts({ request, context, columns, rows, timeZone: plan.timeZone });
  const meta = writeMeta(request.actor, { actorKind: 'import', source: { importId }, enqueueAutomations: false });

  const deadline = Date.now() + COMMIT_BUDGET_MS;
  let committed = claim.import.committed_rows;
  let result = tableImportResult(claim.import);
  while (committed < rows.length && Date.now() < deadline) {
    const from = committed;
    const items = rows
      .slice(from, from + TABLE_IMPORT_CHUNK_ROWS)
      .map((row, offset) => importRowItem(row, from + offset, contexts, plan.hasHeader));
    const chunk = await db.tables.commitImportChunk({ importId, tableId, fromRow: from, items }, data.scope, meta);
    if (!chunk.ok) {
      // Another commit moved it on; report where it stands and leave its lease alone.
      const current = await db.tables.getImport(importId);
      return importProgressView(current ?? claim.import, plan);
    }
    committed = chunk.committedRows;
    result = chunk.result;
    await publishRecordsChanged(
      context,
      data.base,
      tableId,
      chunk.created.map((record) => record.id),
    );
  }
  if (committed >= rows.length) {
    const done = await db.tables.completeImport(importId);
    if (done) return importProgressView(done, plan);
  }
  await db.tables.releaseImportLease(importId);
  return { importId, status: 'committing', totalRows: rows.length, processedRows: committed, result };
}
