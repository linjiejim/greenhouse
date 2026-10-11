/**
 * CSV / Excel import (slice I, spec §6). Both actions need create rights on the
 * table (`tables.data.create`); an import belongs to its uploader and its
 * table, and anyone else's id answers 404.
 *
 * previewImport has two shapes:
 *   - upload `{tableId, file: {name, contentType?, bytes}}` → stage the parsed
 *     rows (≤ 10 MB, ≤ 10,000 rows × 100 columns) → `TableImportPreview`
 *     (columns, samples, inferred types, suggested destinations);
 *   - dry run `{tableId, importId, mapping, hasHeader, createOptions?, timezone?}`
 *     → `TableImportValidation`, the commit's own checks over every row, nothing written.
 *
 * commitImport takes the dry run's input and writes for a few seconds per call
 * (`TableImportProgress`); while `committing`, the client calls again. The
 * first call claims the import and stores its plan; every later call — or a
 * retry after a crash — resumes from `committed_rows` with that plan, so no
 * row is written twice. New fields and new select options need builder plus
 * the structure capability and are made through runtime.dispatch
 * (`createField` / `updateField`, audited as themselves). Records are written
 * with import meta and never enqueue automations (D6).
 */

import { effectiveUserId } from '@greenhouse/platform-kernel';
import {
  TABLE_IMPORT_CHUNK_ROWS,
  TABLE_IMPORT_MAX_FAILURES,
  TABLE_IMPORT_MAX_LIVE_PER_USER,
  tableImportDataRows,
  tableImportError,
  tableImportPlan,
  tableImportResult,
  withImportedOptions,
  type ImportField,
  type TableFieldRow,
  type TableImportClaim,
  type TableImportPlan,
  type TableImportRow,
} from '@greenhouse/db';
import type { TableImportPreview, TableImportProgress, TableImportValidation } from '@greenhouse/types/tables';
import { tableRoleAtLeast } from '@greenhouse/types/table-access';
import { getPlatformRuntime } from '../../runtime.js';
import type { TablesActionId } from '../../manifests/tables.js';
import { requireTableData, type TableDataAccess } from '../access.js';
import { tablesResource, type TablesResourceIds } from '../audit.js';
import { ImportFileError, parseImportFile } from '../import-file.js';
import {
  columnSelectLabels,
  createdFieldConfig,
  importField,
  importRowItem,
  ImportMappingError,
  isImportTarget,
  loadColumnContexts,
  planColumns,
  planFromRequest,
  previewColumns,
} from '../import-plan.js';
import { publishRecordsChanged } from '../realtime.js';
import {
  fail,
  ok,
  payloadOf,
  positiveInt,
  stringValue,
  writeMeta,
  type Handler,
  type HandlerRequest,
  type TablesHandlers,
} from './shared.js';

/** How long one commit call keeps writing before it hands back progress. */
const COMMIT_BUDGET_MS = 5_000;

type Context = Parameters<Handler>[1];

/** Builder (or owner) on the Base and the kernel's structure capability: creating fields / options. */
async function canBuildStructure(request: HandlerRequest, data: TableDataAccess): Promise<boolean> {
  const level = data.access.level;
  if (level === 'none' || level === 'custom' || !tableRoleAtLeast(level, 'builder')) return false;
  return (await getPlatformRuntime().authorize(request.actor, 'tables.structure.update')).allowed;
}

function dispatchAs(request: HandlerRequest, actionId: TablesActionId, payload: unknown, ids: TablesResourceIds) {
  return getPlatformRuntime().dispatch({
    actor: request.actor,
    appId: 'tables',
    actionId,
    payload,
    resource: tablesResource(actionId, ids),
  });
}

function isExpired(row: Pick<TableImportRow, 'expires_at'>): boolean {
  return Date.parse(row.expires_at) <= Date.now();
}

const expired = () =>
  fail('INVALID_INPUT', 'This import has expired — upload the file again', { reason: 'import_expired' });

function mappingFailure(error: unknown) {
  if (!(error instanceof ImportMappingError)) throw error;
  return error.forbidden
    ? fail('FORBIDDEN', error.message, { reason: 'import_forbidden' })
    : fail('INVALID_INPUT', error.message);
}

function progressView(row: TableImportRow, plan = tableImportPlan(row)): TableImportProgress {
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

/** Load the caller's own import on this table, or answer 404. */
async function ownImport(request: HandlerRequest, context: Context, tableId: number, importId: string) {
  const row = await context.db.tables.getImport(importId);
  return row && row.user_id === effectiveUserId(request.actor) && row.table_id === tableId ? row : undefined;
}

// ─── previewImport ────────────────────────────────────────

interface UploadedFile {
  name: string;
  contentType?: string;
  bytes: Uint8Array;
}

function uploadedFile(payload: Record<string, unknown>): UploadedFile | undefined {
  const file = payload.file as Partial<UploadedFile> | undefined;
  return file && typeof file.name === 'string' && file.bytes instanceof Uint8Array
    ? {
        name: file.name,
        contentType: typeof file.contentType === 'string' ? file.contentType : undefined,
        bytes: file.bytes,
      }
    : undefined;
}

async function stageUpload(
  request: HandlerRequest,
  context: Context,
  tableId: number,
  data: TableDataAccess,
  file: UploadedFile,
) {
  if ((await context.db.tables.countLiveImports(effectiveUserId(request.actor))) >= TABLE_IMPORT_MAX_LIVE_PER_USER) {
    return fail('CONFLICT', 'Too many imports are waiting — finish one or wait an hour for them to expire', {
      reason: 'too_many_imports',
    });
  }
  let parsed;
  try {
    parsed = await parseImportFile(file);
  } catch (error) {
    if (error instanceof ImportFileError) return fail('INVALID_INPUT', error.message);
    throw error;
  }
  const staged = await context.db.tables.createImport({
    table_id: tableId,
    user_id: effectiveUserId(request.actor),
    file_name: file.name,
    header: parsed.header,
    rows: parsed.rows,
  });
  const preview: TableImportPreview = {
    importId: staged.id,
    fileName: staged.file_name,
    rowCount: staged.rows.length,
    columns: previewColumns({
      header: staged.header,
      rows: staged.rows,
      fields: await context.db.tables.listFields(tableId, true),
      scope: data.scope,
      canCreateFields: await canBuildStructure(request, data),
    }),
    expiresAt: staged.expires_at,
  };
  return ok(preview);
}

/** The dry run: every row through the commit's coercion, plus required fields (D3: only those the caller may edit). */
async function dryRun(
  request: HandlerRequest,
  context: Context,
  data: TableDataAccess,
  staged: TableImportRow,
  payload: Record<string, unknown>,
) {
  if (staged.status !== 'previewed') return fail('CONFLICT', 'This import has already started');
  if (isExpired(staged)) return expired();
  const fields = await context.db.tables.listFields(staged.table_id, true);
  const createOptions = payload.createOptions === true;
  let plan: TableImportPlan;
  try {
    plan = planFromRequest({
      columns: planColumns({
        mapping: payload.mapping,
        width: staged.header.length,
        fields,
        scope: data.scope,
        canBuild: await canBuildStructure(request, data),
        createOptions,
      }),
      hasHeader: payload.hasHeader,
      createOptions,
      timezone: payload.timezone,
    });
  } catch (error) {
    return mappingFailure(error);
  }
  const rows = tableImportDataRows(staged, plan.hasHeader);
  const byId = new Map(fields.map((field) => [field.id, field]));
  // New fields and new options exist only on paper here: coerce against what they would be.
  const columns = plan.columns.map((column, index) => {
    if (column.create) {
      const field: ImportField = {
        id: -(index + 1),
        name: column.create.name,
        type: column.create.type,
        config: createdFieldConfig(column.create, rows, column.column),
      };
      return { column: column.column, field };
    }
    const field = importField(byId.get(column.fieldId!)!);
    if (plan.createOptions && (field.type === 'single_select' || field.type === 'multi_select')) {
      const labels = columnSelectLabels(field, rows, column.column);
      field.config = { ...field.config, options: withImportedOptions(field.config.options ?? [], labels) };
    }
    return { column: column.column, field };
  });
  const contexts = await loadColumnContexts({ request, context, columns, rows, timeZone: plan.timeZone });

  const mapped = new Set(plan.columns.flatMap((column) => (column.fieldId ? [column.fieldId] : [])));
  const required = fields.filter((field) => field.required && !field.archived_at && isImportTarget(field, data.scope));
  const missingRequired = required.filter((field) => !mapped.has(field.id)).map((field) => field.name);
  const requiredMapped = required.filter((field) => mapped.has(field.id));

  const failed: TableImportValidation['failed'] = [];
  let failedCount = 0;
  rows.forEach((row, index) => {
    const item = importRowItem(row, index, contexts, plan.hasHeader);
    const errors = [...(item.errors ?? [])];
    if (item.values) {
      for (const field of requiredMapped) {
        const value = item.values[String(field.id)];
        if (value === undefined || value === '') errors.push(`Field "${field.name}" is required`);
      }
    }
    if (errors.length === 0) return;
    failedCount += 1;
    if (failed.length < TABLE_IMPORT_MAX_FAILURES) failed.push({ row: item.row, errors });
  });
  const validation: TableImportValidation = {
    totalRows: rows.length,
    validRows: missingRequired.length > 0 ? 0 : rows.length - failedCount,
    failed,
    failedCount,
    missingRequired,
  };
  return ok(validation);
}

const previewImport: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  if (!tableId) return fail('INVALID_INPUT', 'tableId is required');
  const data = await requireTableData(request, context, tableId, 'create');
  if (!data) return fail('NOT_FOUND', 'Table not found');

  const file = uploadedFile(payload);
  if (file) return stageUpload(request, context, tableId, data, file);

  const importId = stringValue(payload, 'importId');
  if (!importId) return fail('INVALID_INPUT', 'A file or an importId is required');
  const staged = await ownImport(request, context, tableId, importId);
  if (!staged) return fail('NOT_FOUND', 'Import not found');
  return dryRun(request, context, data, staged, payload);
};

// ─── commitImport ─────────────────────────────────────────

/** Create the plan's new fields (once — a resume finds them by name) and add missing options. */
async function prepareStructure(
  request: HandlerRequest,
  context: Context,
  claim: Extract<TableImportClaim, { ok: true }>,
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

async function runCommit(
  request: HandlerRequest,
  context: Context,
  data: TableDataAccess,
  claim: Extract<TableImportClaim, { ok: true }>,
): Promise<TableImportProgress> {
  const { db } = context;
  const importId = claim.import.id;
  const tableId = claim.import.table_id;
  const plan = claim.plan;
  const rows = tableImportDataRows(claim.import, plan.hasHeader);

  const structureError = await prepareStructure(request, context, claim, rows);
  if (structureError) {
    const failed = await db.tables.failImport(importId, structureError);
    return progressView(failed ?? claim.import, plan);
  }
  const fields = new Map((await db.tables.listFields(tableId)).map((field) => [field.id, field]));
  const columns: Array<{ column: number; field: ImportField }> = [];
  for (const column of plan.columns) {
    const field = fields.get(column.fieldId ?? 0);
    if (!field) {
      const failed = await db.tables.failImport(importId, 'A mapped field was removed while the import ran');
      return progressView(failed ?? claim.import, plan);
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
      return progressView(current ?? claim.import, plan);
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
    if (done) return progressView(done, plan);
  }
  await db.tables.releaseImportLease(importId);
  return { importId, status: 'committing', totalRows: rows.length, processedRows: committed, result };
}

const commitImport: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const importId = stringValue(payload, 'importId');
  if (!tableId || !importId) return fail('INVALID_INPUT', 'tableId and importId are required');
  const data = await requireTableData(request, context, tableId, 'create');
  if (!data) return fail('NOT_FOUND', 'Table not found');
  const staged = await ownImport(request, context, tableId, importId);
  if (!staged) return fail('NOT_FOUND', 'Import not found');
  if (staged.status === 'committed' || staged.status === 'failed') return ok(progressView(staged));

  // Only a fresh import is planned from the request; a started one keeps its stored plan.
  let plan: TableImportPlan | undefined;
  if (staged.status === 'previewed') {
    if (isExpired(staged)) return expired();
    const createOptions = payload.createOptions === true;
    try {
      plan = planFromRequest({
        columns: planColumns({
          mapping: payload.mapping,
          width: staged.header.length,
          fields: await context.db.tables.listFields(tableId, true),
          scope: data.scope,
          canBuild: await canBuildStructure(request, data),
          createOptions,
        }),
        hasHeader: payload.hasHeader,
        createOptions,
        timezone: payload.timezone,
      });
    } catch (error) {
      return mappingFailure(error);
    }
  }

  const claim = await context.db.tables.claimImport({
    importId,
    userId: effectiveUserId(request.actor),
    tableId,
    plan,
  });
  if (!claim.ok) {
    if (claim.reason === 'not_found') return fail('NOT_FOUND', 'Import not found');
    if (claim.reason === 'expired') return expired();
    if (claim.reason === 'busy') {
      return fail('CONFLICT', 'This import is already running', { reason: 'import_in_progress' });
    }
    return ok(progressView(claim.import!));
  }
  try {
    return ok(await runCommit(request, context, data, claim));
  } catch (error) {
    // Free the lease so a retry resumes now instead of after it expires.
    await context.db.tables.releaseImportLease(importId);
    throw error;
  }
};

export const importHandlers = {
  previewImport,
  commitImport,
} satisfies TablesHandlers;
