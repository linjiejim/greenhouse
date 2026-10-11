/**
 * Tables client · table definitions, fields and schema versions.
 */

import type { TableFieldConfig, TableFieldType, TableSchemaSnapshot } from '@greenhouse/types/tables';
import { rpc } from '../client';
import { responseError } from './shared';
import type { TableView } from './views';

export interface TableDefinition {
  id: number;
  base_id: number;
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
  id: number;
  table_id: number;
  name: string;
  type: TableFieldType;
  required: boolean;
  is_primary: boolean;
  /** JSON-encoded `TableFieldConfig`. */
  config: string;
  position: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface TableSchema {
  table: TableDefinition;
  fields: TableField[];
  views: TableView[];
}

export interface TableSchemaVersion {
  id: number;
  table_id: number;
  version: number;
  schema_snapshot: TableSchemaSnapshot;
  change_type: 'created' | 'field_created' | 'field_updated' | 'field_archived';
  changed_by: string;
  request_id: string | null;
  created_at: string;
}

export async function createTableDefinition(
  baseId: number,
  input: { name: string; description?: string },
): Promise<TableSchema> {
  const args = { param: { baseId: String(baseId) }, json: input };
  const response = await rpc.api.tables.bases[':baseId'].tables.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create Table');
  return response.json();
}

export async function updateTableDefinition(
  tableId: number,
  input: { name?: string; description?: string | null },
): Promise<TableDefinition> {
  const args = { param: { tableId: String(tableId) }, json: input };
  const response = await rpc.api.tables.tables[':tableId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update Table');
  return (await response.json()).table;
}

/**
 * Deleting a table archives it: records, links and fields stay untouched and an
 * administrator can bring it back with `pnpm cli tables restore-table <id>`.
 * Only the Base creator may do this (spec D3).
 */
export async function archiveTableDefinition(tableId: number): Promise<TableDefinition> {
  const response = await rpc.api.tables.tables[':tableId'].archive.$post({ param: { tableId: String(tableId) } });
  if (!response.ok) throw await responseError(response, 'Unable to delete Table');
  return (await response.json()).table;
}

export async function getTableSchema(tableId: number): Promise<TableSchema> {
  const response = await rpc.api.tables.tables[':tableId'].schema.$get({ param: { tableId: String(tableId) } });
  if (!response.ok) throw await responseError(response, 'Unable to load schema');
  return response.json();
}

export async function listTableSchemaVersions(tableId: number): Promise<TableSchemaVersion[]> {
  const response = await rpc.api.tables.tables[':tableId'].schema.versions.$get({
    param: { tableId: String(tableId) },
  });
  if (!response.ok) throw await responseError(response, 'Unable to load schema versions');
  return (await response.json()).versions;
}

export async function createTableField(
  tableId: number,
  input: {
    name: string;
    type: TableFieldType;
    required?: boolean;
    config?: TableFieldConfig;
  },
): Promise<TableField> {
  const args = { param: { tableId: String(tableId) }, json: input };
  const response = await rpc.api.tables.tables[':tableId'].fields.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create field');
  return (await response.json()).field;
}

export async function updateTableField(
  fieldId: number,
  input: { name?: string; required?: boolean; config?: TableFieldConfig; position?: number },
): Promise<TableField> {
  const args = { param: { fieldId: String(fieldId) }, json: input };
  const response = await rpc.api.tables.fields[':fieldId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update field');
  return (await response.json()).field;
}

export async function archiveTableField(fieldId: number): Promise<TableField> {
  const response = await rpc.api.tables.fields[':fieldId'].archive.$post({ param: { fieldId: String(fieldId) } });
  if (!response.ok) throw await responseError(response, 'Unable to archive field');
  return (await response.json()).field;
}
