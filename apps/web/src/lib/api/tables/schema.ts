/**
 * Tables client · table definitions, fields and schema versions.
 */

import type { TableFieldConfig, TableFieldType } from '@greenhouse/types/tables';
import type { TableDefinition, TableField, TableSchema, TableSchemaVersion } from '@greenhouse/types/tables-wire';
import { rpc } from '../client';
import { responseError } from './shared';

// The response shapes live in `@greenhouse/types/tables-wire` (one copy for web and mobile).
export type { TableDefinition, TableField, TableSchema, TableSchemaVersion } from '@greenhouse/types/tables-wire';

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
 * A structure change apps depend on (archiving a table or field, removing
 * select options) answers 409 `used_by_apps` (Phase 1 D6) until it is resent
 * with `{confirm: true}` — see `components/tables/app-references.tsx`.
 */
export interface AppReferenceConfirm {
  confirm?: boolean;
}

/** Only `confirm: true` travels; an unconfirmed write sends no body field. */
function confirmBody(options: AppReferenceConfirm): { confirm?: true } {
  return options.confirm ? { confirm: true } : {};
}

/**
 * Deleting a table archives it: records, links and fields stay untouched and an
 * administrator can bring it back with `pnpm cli tables restore-table <id>`.
 * Only the Base creator may do this (spec D3).
 */
export async function archiveTableDefinition(
  tableId: number,
  options: AppReferenceConfirm = {},
): Promise<TableDefinition> {
  const args = { param: { tableId: String(tableId) }, json: confirmBody(options) };
  const response = await rpc.api.tables.tables[':tableId'].archive.$post(args);
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
  options: AppReferenceConfirm = {},
): Promise<TableField> {
  const args = { param: { fieldId: String(fieldId) }, json: { ...input, ...confirmBody(options) } };
  const response = await rpc.api.tables.fields[':fieldId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update field');
  return (await response.json()).field;
}

export async function archiveTableField(fieldId: number, options: AppReferenceConfirm = {}): Promise<TableField> {
  const args = { param: { fieldId: String(fieldId) }, json: confirmBody(options) };
  const response = await rpc.api.tables.fields[':fieldId'].archive.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to archive field');
  return (await response.json()).field;
}
