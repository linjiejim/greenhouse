/**
 * Tables client · forms (builder side and the submit page).
 * Slice Fm moves the submit side onto `/api/forms`.
 */

import type { TableFormConfig, TableRecordValues } from '@greenhouse/types/tables';
import { authFetch } from '../../auth';
import { responseError } from './shared';
import type { TableRecord } from './records';
import type { TableField } from './schema';

export interface TableForm {
  id: number;
  table_id: number;
  name: string;
  status: 'draft' | 'published';
  config: TableFormConfig;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export async function listTableForms(tableId: number): Promise<TableForm[]> {
  const response = await authFetch(`/api/tables/tables/${tableId}/forms`);
  if (!response.ok) throw await responseError(response, 'Unable to load forms');
  return ((await response.json()) as { forms: TableForm[] }).forms;
}

export async function getTableForm(formId: number): Promise<{ form: TableForm; fields: TableField[] }> {
  const response = await authFetch(`/api/tables/forms/${formId}`);
  if (!response.ok) throw await responseError(response, 'Unable to load form');
  return response.json() as Promise<{ form: TableForm; fields: TableField[] }>;
}

export async function createTableForm(
  tableId: number,
  input: { name: string; status?: 'draft' | 'published'; config: TableFormConfig },
): Promise<TableForm> {
  const response = await authFetch(`/api/tables/tables/${tableId}/forms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Unable to create form');
  return ((await response.json()) as { form: TableForm }).form;
}

export async function updateTableForm(
  formId: number,
  input: { revision: number; name?: string; status?: 'draft' | 'published'; config?: TableFormConfig },
): Promise<TableForm> {
  const response = await authFetch(`/api/tables/forms/${formId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Unable to update form');
  return ((await response.json()) as { form: TableForm }).form;
}

export async function submitTableForm(formId: number, values: TableRecordValues): Promise<TableRecord> {
  const response = await authFetch(`/api/tables/forms/${formId}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!response.ok) throw await responseError(response, 'Unable to submit form');
  return ((await response.json()) as { record: TableRecord }).record;
}
