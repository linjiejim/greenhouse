/**
 * Tables client · forms. Builders configure them under `/api/tables`; everyone
 * in a form's audience opens, uploads to and submits it under `/api/forms`
 * (not behind the Tables feature flag — the audience need not use Tables).
 */

import type {
  TableFormAudience,
  TableFormConfig,
  TableFormSubmitResult,
  TableFormSubmitView,
  TableFormUploadView,
  TableRecordValues,
} from '@greenhouse/types/tables';
import type { TableForm } from '@greenhouse/types/tables-wire';
import { authFetch } from '../../auth';
import { rpc } from '../client';
import { responseError } from './shared';

// The response shape lives in `@greenhouse/types/tables-wire` (one copy for web and mobile).
export type { TableForm } from '@greenhouse/types/tables-wire';

export interface TableFormInput {
  name: string;
  status?: 'draft' | 'published';
  config: TableFormConfig;
  audience?: TableFormAudience;
}

export async function listTableForms(tableId: number): Promise<TableForm[]> {
  const response = await rpc.api.tables.tables[':tableId'].forms.$get({ param: { tableId: String(tableId) } });
  if (!response.ok) throw await responseError(response, 'Unable to load forms');
  return (await response.json()).forms;
}

export async function createTableForm(tableId: number, input: TableFormInput): Promise<TableForm> {
  const args = { param: { tableId: String(tableId) }, json: input };
  const response = await rpc.api.tables.tables[':tableId'].forms.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create form');
  return (await response.json()).form;
}

export async function updateTableForm(
  formId: number,
  input: Partial<TableFormInput> & { revision: number },
): Promise<TableForm> {
  const args = { param: { formId: String(formId) }, json: input };
  const response = await rpc.api.tables.forms[':formId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update form');
  return (await response.json()).form;
}

/** The submit view for the signed-in person; 404 `details.reason = 'not_published'` for a draft they could submit to. */
export async function openTableForm(formId: number): Promise<TableFormSubmitView> {
  const response = await rpc.api.forms[':formId'].$get({ param: { formId: String(formId) } });
  if (!response.ok) throw await responseError(response, 'Unable to load form');
  return (await response.json()).form;
}

/** Stage one attachment for this form; it is bound when the same person submits. */
export async function uploadTableFormFile(formId: number, file: File): Promise<TableFormUploadView> {
  const body = new FormData();
  body.append('file', file);
  const response = await authFetch(`/api/forms/${formId}/uploads`, { method: 'POST', body });
  if (!response.ok) throw await responseError(response, 'Unable to upload file');
  return ((await response.json()) as { file: TableFormUploadView }).file;
}

/** Submit; the server answers only with the success copy (409 `already_submitted` for a used single-submit form). */
export async function submitTableForm(formId: number, values: TableRecordValues): Promise<TableFormSubmitResult> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const args = { param: { formId: String(formId) }, json: { values, timeZone } };
  const response = await rpc.api.forms[':formId'].submit.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to submit form');
  return response.json();
}
