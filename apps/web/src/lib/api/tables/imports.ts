/**
 * Tables client · CSV / Excel import: upload (preview), dry run, commit.
 *
 * The upload is FormData, so it stays on raw `authFetch`; the dry run and the
 * commit are typed through `rpc`. A commit call writes for a few seconds and
 * answers progress — `commitTableImportAll` keeps calling while the import is
 * `committing`, the same input every time (the server resumes with the plan it
 * stored on the first call).
 */

import type {
  TableImportCommitInput,
  TableImportPreview,
  TableImportProgress,
  TableImportValidation,
} from '@greenhouse/types/tables';
import { authFetch } from '../../auth';
import { rpc } from '../client';
import { responseError, TablesRequestError } from './shared';

export type { TableImportPreview, TableImportProgress, TableImportValidation };

/** What the dry run and the commit take (the import id travels in the path). */
export type TableImportRequest = Omit<TableImportCommitInput, 'importId'>;

export async function uploadTableImport(tableId: number, file: File): Promise<TableImportPreview> {
  const form = new FormData();
  form.append('file', file);
  const response = await authFetch(`/api/tables/tables/${tableId}/imports`, { method: 'POST', body: form });
  if (!response.ok) throw await responseError(response, 'Unable to read this file');
  return (await response.json()) as TableImportPreview;
}

export async function validateTableImport(
  tableId: number,
  importId: string,
  input: TableImportRequest,
): Promise<TableImportValidation> {
  const args = { param: { tableId: String(tableId), importId: encodeURIComponent(importId) }, json: input };
  const response = await rpc.api.tables.tables[':tableId'].imports[':importId'].validate.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to check this import');
  return response.json();
}

export async function commitTableImport(
  tableId: number,
  importId: string,
  input: TableImportRequest,
): Promise<TableImportProgress> {
  const args = { param: { tableId: String(tableId), importId: encodeURIComponent(importId) }, json: input };
  const response = await rpc.api.tables.tables[':tableId'].imports[':importId'].commit.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to import');
  return response.json();
}

/** How often the loop retries while another commit of the same import holds it, and how long it waits. */
const BUSY_RETRIES = 30;
const BUSY_WAIT_MS = 2_000;
/** Calls in a row without progress before the loop gives up (another tab is moving it on). */
const MAX_STALLED_CALLS = 30;

function isBusy(error: unknown): boolean {
  return error instanceof TablesRequestError && error.status === 409 && error.details?.reason === 'import_in_progress';
}

/**
 * Commit until the import is finished (or failed), reporting each step's
 * progress. While another call holds the import (a second tab, a retry right
 * after a dropped connection) it waits and asks again.
 */
export async function commitTableImportAll(
  tableId: number,
  importId: string,
  input: TableImportRequest,
  onProgress: (progress: TableImportProgress) => void,
): Promise<TableImportProgress> {
  let busy = 0;
  let stalled = 0;
  let processed = -1;
  for (;;) {
    let progress: TableImportProgress;
    try {
      progress = await commitTableImport(tableId, importId, input);
    } catch (error) {
      if (!isBusy(error) || ++busy > BUSY_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
      continue;
    }
    busy = 0;
    onProgress(progress);
    if (progress.status !== 'committing') return progress;
    stalled = progress.processedRows > processed ? 0 : stalled + 1;
    processed = progress.processedRows;
    if (stalled >= MAX_STALLED_CALLS) throw new Error('The import is not making progress');
  }
}
