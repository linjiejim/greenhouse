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

/** A new private base with one empty table (`POST /api/tables/bases`), mine as owner. */
export const createBase = (name: string) => post<{ base: TableBase }>('/api/tables/bases', { name });

export const getBase = (baseId: string) =>
  get<{ base: TableBase; role: TableRole; tables: TableDef[] }>(`/api/tables/bases/${seg(String(baseId))}`);

export const getSchema = (tableId: string) => get<TableSchema>(`/api/tables/tables/${seg(String(tableId))}/schema`);

/** One page of records, newest first; pass the previous page's `nextCursor` for the next. */
export const queryRecords = (tableId: string, cursor: string | null, limit = 50, query: Record<string, unknown> = {}) =>
  post<TableRecordPage>(`/api/tables/tables/${seg(String(tableId))}/records/query`, {
    sort: [{ systemField: 'created_at', direction: 'desc' }],
    ...query,
    limit,
    ...(cursor ? { cursor } : {}),
  });

export const getRecord = (tableId: string, recordId: string) =>
  get<{ record: TableRecord }>(`/api/tables/tables/${seg(String(tableId))}/records/${seg(String(recordId))}`);

export const createRecord = (tableId: string, values: Record<string, unknown>) =>
  post<{ record: TableRecord }>(`/api/tables/tables/${seg(String(tableId))}/records`, { values });

export const tableUsers = () => get<{ users: TableUser[] }>('/api/tables/meta/users');
