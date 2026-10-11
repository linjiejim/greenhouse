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
  TABLE_IMPORT_MAX_FAILURES,
  TABLE_IMPORT_MAX_LIVE_PER_USER,
  tableImportDataRows,
  withImportedOptions,
  type ImportField,
  type TableImportPlan,
  type TableImportRow,
} from '@greenhouse/db';
import type { TableImportPreview, TableImportValidation } from '@greenhouse/types/tables';
import { tableRoleAtLeast } from '@greenhouse/types/table-access';
import { getPlatformRuntime } from '../../runtime.js';
import { requireTableData, type TableDataAccess } from '../access.js';
import { importProgressView, runImportCommit } from '../import-commit.js';
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
import {
  fail,
  ok,
  payloadOf,
  positiveInt,
  stringValue,
  type Handler,
  type HandlerRequest,
  type TablesHandlers,
} from './shared.js';

type Context = Parameters<Handler>[1];

/** Builder (or owner) on the Base and the kernel's structure capability: creating fields / options. */
async function canBuildStructure(request: HandlerRequest, data: TableDataAccess): Promise<boolean> {
  const level = data.access.level;
  if (level === 'none' || level === 'custom' || !tableRoleAtLeast(level, 'builder')) return false;
  return (await getPlatformRuntime().authorize(request.actor, 'tables.structure.update')).allowed;
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

const commitImport: Handler = async (request, context) => {
  const payload = payloadOf(request);
  const tableId = positiveInt(payload, 'tableId');
  const importId = stringValue(payload, 'importId');
  if (!tableId || !importId) return fail('INVALID_INPUT', 'tableId and importId are required');
  const data = await requireTableData(request, context, tableId, 'create');
  if (!data) return fail('NOT_FOUND', 'Table not found');
  const staged = await ownImport(request, context, tableId, importId);
  if (!staged) return fail('NOT_FOUND', 'Import not found');
  if (staged.status === 'committed' || staged.status === 'failed') return ok(importProgressView(staged));

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
    return ok(importProgressView(claim.import!));
  }
  try {
    return ok(await runImportCommit(request, context, data, claim));
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
