/**
 * Tables client · a record's activity: comments and change history.
 *
 * The server merges comments with history newest first and cuts field changes
 * to what the caller may read; `viewer` says whether the caller may comment
 * and moderate. Bodies are Markdown with `[@Name](user:<id>)` mentions
 * (`@greenhouse/utils/mentions`).
 */

import type { TableRecordActivityPage, TableRecordCommentView } from '@greenhouse/types/tables';
import { rpc } from '../client';
import { responseError } from './shared';

export type {
  TableRecordActivityItem,
  TableRecordActivityPage,
  TableRecordActivityViewer,
  TableRecordCommentView,
  TableRecordEventView,
} from '@greenhouse/types/tables';

/** One page of a record's activity; pass the previous page's `nextCursor` for older items. */
export async function listTableRecordActivity(
  tableId: number,
  recordId: number,
  cursor?: string | null,
): Promise<TableRecordActivityPage> {
  const args = {
    param: { tableId: String(tableId), recordId: String(recordId) },
    query: cursor ? { cursor } : {},
  };
  const response = await rpc.api.tables.tables[':tableId'].records[':recordId'].activity.$get(args);
  if (!response.ok) throw await responseError(response, 'Unable to load activity');
  return response.json();
}

export async function createTableRecordComment(
  tableId: number,
  recordId: number,
  body: string,
): Promise<TableRecordCommentView> {
  const args = { param: { tableId: String(tableId), recordId: String(recordId) }, json: { body } };
  const response = await rpc.api.tables.tables[':tableId'].records[':recordId'].comments.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to post comment');
  return (await response.json()).comment;
}

/** Only the author may edit; the server answers 403 otherwise. */
export async function updateTableRecordComment(commentId: number, body: string): Promise<TableRecordCommentView> {
  const args = { param: { commentId: String(commentId) }, json: { body } };
  const response = await rpc.api.tables.comments[':commentId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update comment');
  return (await response.json()).comment;
}

/** The author or a Base builder+ may delete (soft). */
export async function deleteTableRecordComment(commentId: number): Promise<void> {
  const args = { param: { commentId: String(commentId) } };
  const response = await rpc.api.tables.comments[':commentId'].$delete(args);
  if (!response.ok) throw await responseError(response, 'Unable to delete comment');
}
