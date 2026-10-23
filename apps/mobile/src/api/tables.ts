/**
 * Tables (`/api/tables`, apps/api/src/routes/tables.ts; feature `tables`): bases, a base's tables,
 * a table's schema, records by cursor page, one record, and adding a record. A base, table or
 * record the member cannot read answers 404; the feature or role gate answers 403. Every call
 * answers an `ApiResult`, never throws.
 */

import type {
  TableBase,
  TableDef,
  TableRecord,
  TableRecordPage,
  TableRole,
  TableSchema,
  TableUser,
} from '../shared/greenhouse-types';
import { get, post, seg } from './client';

export const listBases = () => get<{ bases: TableBase[] }>('/api/tables/bases');

export const getBase = (baseId: number) =>
  get<{ base: TableBase; role: TableRole; tables: TableDef[] }>(`/api/tables/bases/${seg(String(baseId))}`);

export const getSchema = (tableId: number) => get<TableSchema>(`/api/tables/tables/${seg(String(tableId))}/schema`);

/** One page of records, newest first; pass the previous page's `nextCursor` for the next. */
export const queryRecords = (tableId: number, cursor: string | null, limit = 50) =>
  post<TableRecordPage>(`/api/tables/tables/${seg(String(tableId))}/records/query`, {
    sort: [{ systemField: 'created_at', direction: 'desc' }],
    limit,
    ...(cursor ? { cursor } : {}),
  });

export const getRecord = (tableId: number, recordId: number) =>
  get<{ record: TableRecord }>(`/api/tables/tables/${seg(String(tableId))}/records/${seg(String(recordId))}`);

export const createRecord = (tableId: number, values: Record<string, unknown>) =>
  post<{ record: TableRecord }>(`/api/tables/tables/${seg(String(tableId))}/records`, { values });

export const tableUsers = () => get<{ users: TableUser[] }>('/api/tables/meta/users');
