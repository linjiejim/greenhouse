/**
 * Tables client · saved views.
 */

import type { TableViewConfig, TableViewScope, TableViewType } from '@greenhouse/types/tables';
import { rpc } from '../client';
import { responseError } from './shared';

export interface TableView {
  id: number;
  table_id: number;
  name: string;
  type: TableViewType;
  scope: TableViewScope;
  owner_id: string | null;
  /** JSON-encoded `TableViewConfig`. */
  config: string;
  position: number;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function createTableView(
  tableId: number,
  input: { name: string; scope: TableViewScope; type?: TableViewType; config?: TableViewConfig },
): Promise<TableView> {
  const args = { param: { tableId: String(tableId) }, json: input };
  const response = await rpc.api.tables.tables[':tableId'].views.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create view');
  return (await response.json()).view;
}

/** Revision-checked; `type` switches the view's type (its config is re-validated for it). */
export async function updateTableView(
  viewId: number,
  input: { revision: number; name?: string; type?: TableViewType; config?: TableViewConfig; position?: number },
): Promise<TableView> {
  const args = { param: { viewId: String(viewId) }, json: input };
  const response = await rpc.api.tables.views[':viewId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update view');
  return (await response.json()).view;
}

/** Hard delete: your own personal view (editor+), or a shared one (builder). */
export async function deleteTableView(viewId: number): Promise<void> {
  const args = { param: { viewId: String(viewId) } };
  const response = await rpc.api.tables.views[':viewId'].$delete(args);
  if (!response.ok) throw await responseError(response, 'Unable to delete view');
}
