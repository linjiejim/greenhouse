/**
 * Typed Tables API client.
 */

import type {
  SchemaPlanApplyResult,
  SchemaPlanOperation,
  TableBaseRole,
  TableBaseVisibility,
  TableFieldConfig,
  TableFieldType,
  TableQuery,
  TableRecordValues,
  TableSchemaSnapshot,
  TableViewConfig,
} from '@greenhouse/types/tables';
import { authFetch } from '../auth';
import { rpc } from './client';

export interface TableBase {
  id: string;
  name: string;
  description: string | null;
  visibility: TableBaseVisibility;
  owner_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface TableBaseWithRole extends TableBase {
  role: TableBaseRole;
}

export interface TableDefinition {
  id: string;
  base_id: string;
  name: string;
  description: string | null;
  position: number;
  schema_revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface TableField {
  id: string;
  table_id: string;
  name: string;
  type: TableFieldType;
  required: boolean;
  is_primary: boolean;
  config: TableFieldConfig;
  position: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface TableView {
  id: string;
  table_id: string;
  name: string;
  type: 'grid';
  scope: 'shared' | 'personal';
  owner_id: string | null;
  config: TableViewConfig;
  position: number;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface TableRecord {
  id: string;
  table_id: string;
  values: TableRecordValues;
  computed_values: TableRecordValues;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface TableSchema {
  table: TableDefinition;
  fields: TableField[];
  views: TableView[];
}

export interface TableRecordPage {
  records: TableRecord[];
  total: number;
  nextCursor: string | null;
}

export interface TableSchemaVersion {
  id: string;
  table_id: string;
  version: number;
  schema_snapshot: TableSchemaSnapshot;
  change_type: 'created' | 'field_created' | 'field_updated' | 'field_archived';
  changed_by: string;
  request_id: string | null;
  created_at: string;
}

export interface TableBatchRecordItem {
  record_id?: string;
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

export interface TableAuditEvent {
  id: string;
  org_id: string;
  actor_id: string;
  actor_type: 'human' | 'agent' | 'service' | 'system' | 'migration';
  on_behalf_of_user_id: string | null;
  client_id: string | null;
  request_id: string;
  app_id: string;
  module_id: string | null;
  entity_id: string | null;
  record_id: string | null;
  action_id: string;
  capability: string;
  result: 'success' | 'denied' | 'error';
  summary: string;
  created_at: string;
}

export interface TableBaseWorkspace {
  base: TableBase;
  role: TableBaseRole;
  tables: TableDefinition[];
  members: Array<{
    id: string;
    base_id: string;
    user_id: string;
    role: TableBaseRole;
    added_by: string;
    created_at: string;
    updated_at: string;
  }>;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error || fallback);
}

export async function listTableBases(search?: string): Promise<TableBaseWithRole[]> {
  const response = await rpc.api.tables.bases.$get({ query: search ? { search } : {} });
  if (!response.ok) throw await responseError(response, 'Unable to load Tables');
  return (await response.json()).bases;
}

export async function createTableBase(input: {
  name: string;
  description?: string;
  visibility: TableBaseVisibility;
  defaultTableName?: string;
}): Promise<{ base: TableBase; role: 'owner'; schema: TableSchema }> {
  const response = await rpc.api.tables.bases.$post({ json: input });
  if (!response.ok) throw await responseError(response, 'Unable to create Base');
  return response.json();
}

export async function getTableBase(baseId: string): Promise<TableBaseWorkspace> {
  const response = await rpc.api.tables.bases[':baseId'].$get({ param: { baseId: baseId } });
  if (!response.ok) throw await responseError(response, 'Unable to load Base');
  return response.json();
}

export async function listTableUsers(): Promise<
  Array<{ id: string; nickname: string; email: string; role: 'team' | 'super' }>
> {
  const response = await rpc.api.tables.meta.users.$get();
  if (!response.ok) throw await responseError(response, 'Unable to load users');
  return (await response.json()).users;
}

export async function updateTableBase(
  baseId: string,
  input: { name?: string; description?: string | null; visibility?: TableBaseVisibility },
): Promise<TableBase> {
  const args = { param: { baseId: baseId }, json: input };
  const response = await rpc.api.tables.bases[':baseId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update Base');
  return (await response.json()).base;
}

export async function upsertTableBaseMember(
  baseId: string,
  userId: string,
  role: Exclude<TableBaseRole, 'owner'>,
): Promise<TableBaseWorkspace['members'][number]> {
  const args = { param: { baseId: baseId, userId }, json: { role } };
  const response = await rpc.api.tables.bases[':baseId'].members[':userId'].$put(args);
  if (!response.ok) throw await responseError(response, 'Unable to update member');
  return (await response.json()).member;
}

export async function removeTableBaseMember(baseId: string, userId: string): Promise<void> {
  const response = await rpc.api.tables.bases[':baseId'].members[':userId'].$delete({
    param: { baseId: baseId, userId },
  });
  if (!response.ok) throw await responseError(response, 'Unable to remove member');
}

export async function listTableBaseAudit(baseId: string, limit = 100): Promise<TableAuditEvent[]> {
  const response = await authFetch(`/api/tables/bases/${baseId}/audit?limit=${limit}`);
  if (!response.ok) throw await responseError(response, 'Unable to load Base audit');
  return ((await response.json()) as { events: TableAuditEvent[] }).events;
}

export async function createTableDefinition(
  baseId: string,
  input: { name: string; description?: string },
): Promise<TableSchema> {
  const args = { param: { baseId: baseId }, json: input };
  const response = await rpc.api.tables.bases[':baseId'].tables.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create Table');
  return response.json();
}

export async function updateTableDefinition(
  tableId: string,
  input: { name?: string; description?: string | null },
): Promise<TableDefinition> {
  const args = { param: { tableId: tableId }, json: input };
  const response = await rpc.api.tables.tables[':tableId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update Table');
  return (await response.json()).table;
}

/**
 * Deleting a table archives it: records, links and fields stay untouched and an
 * administrator can bring it back with `pnpm cli tables restore-table <id>`.
 * Only the Base creator may do this (spec D3).
 */
export async function archiveTableDefinition(tableId: string): Promise<TableDefinition> {
  const response = await rpc.api.tables.tables[':tableId'].archive.$post({ param: { tableId: tableId } });
  if (!response.ok) throw await responseError(response, 'Unable to delete Table');
  return (await response.json()).table;
}

export async function archiveTableBase(baseId: string): Promise<TableBase> {
  const response = await rpc.api.tables.bases[':baseId'].archive.$post({ param: { baseId: baseId } });
  if (!response.ok) throw await responseError(response, 'Unable to delete Base');
  return (await response.json()).base;
}

export async function getTableSchema(tableId: string): Promise<TableSchema> {
  const response = await rpc.api.tables.tables[':tableId'].schema.$get({ param: { tableId: tableId } });
  if (!response.ok) throw await responseError(response, 'Unable to load schema');
  return response.json();
}

export async function listTableSchemaVersions(tableId: string): Promise<TableSchemaVersion[]> {
  const response = await rpc.api.tables.tables[':tableId'].schema.versions.$get({
    param: { tableId: tableId },
  });
  if (!response.ok) throw await responseError(response, 'Unable to load schema versions');
  return (await response.json()).versions;
}

export async function createTableField(
  tableId: string,
  input: {
    name: string;
    type: TableFieldType;
    required?: boolean;
    config?: TableFieldConfig;
  },
): Promise<TableField> {
  const args = { param: { tableId: tableId }, json: input };
  const response = await rpc.api.tables.tables[':tableId'].fields.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create field');
  return (await response.json()).field;
}

export async function updateTableField(
  fieldId: string,
  input: { name?: string; required?: boolean; config?: TableFieldConfig; position?: number },
): Promise<TableField> {
  const args = { param: { fieldId: fieldId }, json: input };
  const response = await rpc.api.tables.fields[':fieldId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update field');
  return (await response.json()).field;
}

export async function archiveTableField(fieldId: string): Promise<TableField> {
  const response = await rpc.api.tables.fields[':fieldId'].archive.$post({ param: { fieldId: fieldId } });
  if (!response.ok) throw await responseError(response, 'Unable to archive field');
  return (await response.json()).field;
}

/**
 * Applies a schema plan the model drafted and the user confirmed. This is the
 * only way a `tables_schema_plan` card becomes real — the tool itself writes
 * nothing, and the server re-authorizes every operation on its own.
 */
export async function applyTableSchemaPlan(
  operations: SchemaPlanOperation[],
  receipt: { actionId: string; sessionId: string },
): Promise<SchemaPlanApplyResult> {
  const response = await rpc.api.tables['schema-plan'].apply.$post({
    json: { operations, action_id: receipt.actionId, session_id: receipt.sessionId },
  });
  if (!response.ok) throw await responseError(response, 'Unable to apply the schema plan');
  return await response.json();
}

export async function createTableView(
  tableId: string,
  input: { name: string; scope: 'shared' | 'personal'; config?: Record<string, unknown> },
): Promise<TableView> {
  const args = { param: { tableId: tableId }, json: input };
  const response = await rpc.api.tables.tables[':tableId'].views.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create view');
  return (await response.json()).view;
}

export async function updateTableView(
  viewId: string,
  input: { revision: number; name?: string; config?: Record<string, unknown>; position?: number },
): Promise<TableView> {
  const args = { param: { viewId: viewId }, json: input };
  const response = await rpc.api.tables.views[':viewId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update view');
  return (await response.json()).view;
}

export async function queryTableRecords(tableId: string, query: TableQuery): Promise<TableRecordPage> {
  const args = { param: { tableId: tableId }, json: query };
  const response = await rpc.api.tables.tables[':tableId'].records.query.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to query records');
  return response.json();
}

export async function createTableRecord(tableId: string, values: TableRecordValues): Promise<TableRecord> {
  const args = { param: { tableId: tableId }, json: { values } };
  const response = await rpc.api.tables.tables[':tableId'].records.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create record');
  return (await response.json()).record;
}

export async function updateTableRecord(
  tableId: string,
  recordId: string,
  revision: number,
  values: TableRecordValues,
): Promise<TableRecord> {
  const args = {
    param: { tableId: tableId, recordId: recordId },
    json: { revision, values },
  };
  const response = await rpc.api.tables.tables[':tableId'].records[':recordId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update record');
  return (await response.json()).record;
}

export async function validateTableRecordBatch(
  tableId: string,
  items: TableBatchRecordItem[],
): Promise<TableBatchValidation[]> {
  const args = { param: { tableId: tableId }, json: { items } };
  const response = await rpc.api.tables.tables[':tableId'].records['batch-validate'].$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to validate pasted records');
  return (await response.json()).results;
}

export async function upsertTableRecordBatch(
  tableId: string,
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
  const args = { param: { tableId: tableId }, json: { items } };
  const response = await rpc.api.tables.tables[':tableId'].records['batch-upsert'].$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to paste records');
  return (await response.json()).results;
}

export async function deleteTableRecord(tableId: string, recordId: string, revision: number): Promise<void> {
  const response = await authFetch(`/api/tables/tables/${tableId}/records/${recordId}?revision=${revision}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw await responseError(response, 'Unable to delete record');
}

/** The recycle bin feed — soft-deleted rows, newest first. */
export async function listDeletedTableRecords(tableId: string, limit = 100): Promise<TableRecord[]> {
  const response = await authFetch(`/api/tables/tables/${tableId}/records/deleted?limit=${limit}`);
  if (!response.ok) throw await responseError(response, 'Unable to load deleted records');
  return ((await response.json()) as { records: TableRecord[] }).records;
}

export async function restoreTableRecord(tableId: string, recordId: string): Promise<TableRecord> {
  const args = { param: { tableId: tableId, recordId: recordId } };
  const response = await rpc.api.tables.tables[':tableId'].records[':recordId'].restore.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to restore record');
  return (await response.json()).record;
}
