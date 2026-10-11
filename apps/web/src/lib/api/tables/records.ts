/**
 * Tables client · records: query, read one, write, paste batches, the recycle bin.
 */

import type { TableQuery, TableRecordValues } from '@greenhouse/types/tables';
import { authFetch } from '../../auth';
import { rpc } from '../client';
import { isTablesConflict, responseError } from './shared';

export interface TableRecord {
  id: number;
  table_id: number;
  values: TableRecordValues;
  computed_values: TableRecordValues;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TableRecordPage {
  records: TableRecord[];
  total: number;
  nextCursor: string | null;
}

export interface TableBatchRecordItem {
  record_id?: number;
  revision?: number;
  values: TableRecordValues;
}

export type TableBatchValidation = {
  index: number;
  ok: boolean;
  reason?: 'not_found' | 'conflict' | 'invalid';
  message?: string;
  current?: number;
};

export async function queryTableRecords(tableId: number, query: TableQuery): Promise<TableRecordPage> {
  const args = { param: { tableId: String(tableId) }, json: query };
  const response = await rpc.api.tables.tables[':tableId'].records.query.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to query records');
  return response.json();
}

/** One live record; a record the caller may not see is a 404, exactly like a missing one. */
export async function getTableRecord(tableId: number, recordId: number): Promise<TableRecord> {
  const args = { param: { tableId: String(tableId), recordId: String(recordId) } };
  const response = await rpc.api.tables.tables[':tableId'].records[':recordId'].$get(args);
  if (!response.ok) throw await responseError(response, 'Unable to load record');
  return (await response.json()).record;
}

export async function createTableRecord(tableId: number, values: TableRecordValues): Promise<TableRecord> {
  const args = { param: { tableId: String(tableId) }, json: { values } };
  const response = await rpc.api.tables.tables[':tableId'].records.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create record');
  return (await response.json()).record;
}

export async function updateTableRecord(
  tableId: number,
  recordId: number,
  revision: number,
  values: TableRecordValues,
): Promise<TableRecord> {
  const args = {
    param: { tableId: String(tableId), recordId: String(recordId) },
    json: { revision, values },
  };
  const response = await rpc.api.tables.tables[':tableId'].records[':recordId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update record');
  return (await response.json()).record;
}

export async function validateTableRecordBatch(
  tableId: number,
  items: TableBatchRecordItem[],
): Promise<TableBatchValidation[]> {
  const args = { param: { tableId: String(tableId) }, json: { items } };
  const response = await rpc.api.tables.tables[':tableId'].records['batch-validate'].$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to validate pasted records');
  return (await response.json()).results;
}

export async function upsertTableRecordBatch(
  tableId: number,
  items: TableBatchRecordItem[],
): Promise<
  Array<
    | { index: number; ok: true; record: TableRecord }
    | {
        index: number;
        ok: false;
        reason: 'not_found' | 'conflict' | 'invalid';
        message?: string;
        current?: number;
      }
  >
> {
  const args = { param: { tableId: String(tableId) }, json: { items } };
  const response = await rpc.api.tables.tables[':tableId'].records['batch-upsert'].$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to paste records');
  return (await response.json()).results;
}

export async function deleteTableRecord(tableId: number, recordId: number, revision: number): Promise<void> {
  const response = await authFetch(`/api/tables/tables/${tableId}/records/${recordId}?revision=${revision}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw await responseError(response, 'Unable to delete record');
}

/** The recycle bin feed — soft-deleted rows, newest first. */
export async function listDeletedTableRecords(tableId: number, limit = 100): Promise<TableRecord[]> {
  const response = await authFetch(`/api/tables/tables/${tableId}/records/deleted?limit=${limit}`);
  if (!response.ok) throw await responseError(response, 'Unable to load deleted records');
  return ((await response.json()) as { records: TableRecord[] }).records;
}

export async function restoreTableRecord(tableId: number, recordId: number): Promise<TableRecord> {
  const args = { param: { tableId: String(tableId), recordId: String(recordId) } };
  const response = await rpc.api.tables.tables[':tableId'].records[':recordId'].restore.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to restore record');
  return (await response.json()).record;
}

/**
 * Update a record, recovering from a stale revision when it is safe to.
 *
 * Automations now run asynchronously and can bump a record's revision seconds
 * after a person edits it, so a follow-up edit (a kanban drag, an inline cell)
 * would otherwise fail with 409. On a conflict the record is re-read: if none
 * of the fields this patch writes changed on the server since `base` (the
 * snapshot the user was looking at), the patch is replayed on the new revision;
 * otherwise the conflict is rethrown for the caller to report.
 */
export async function updateTableRecordWithReplay(
  tableId: number,
  base: Pick<TableRecord, 'id' | 'revision' | 'values'>,
  values: TableRecordValues,
): Promise<TableRecord> {
  try {
    return await updateTableRecord(tableId, base.id, base.revision, values);
  } catch (error) {
    if (!isTablesConflict(error)) throw error;
    const current = await getTableRecord(tableId, base.id);
    const touched = Object.keys(values);
    const unchanged = touched.every(
      (key) => JSON.stringify(current.values[key] ?? null) === JSON.stringify(base.values[key] ?? null),
    );
    if (!unchanged) throw error;
    return updateTableRecord(tableId, base.id, current.revision, values);
  }
}
