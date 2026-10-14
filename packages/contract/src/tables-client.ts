/** The 表格 calls of the typed client (`client.tables`). */

import type { Page } from './common.js';
import type { KnowledgeComment } from './knowledge.js';
import type { KnowledgeHttp } from './knowledge-client.js';
import { cardsApi } from './tables-cards-client.js';
import { formsApi } from './tables-forms-client.js';
import { importsApi } from './tables-imports-client.js';
import type {
  Base,
  BaseAuditEntry,
  BaseShareInput,
  BaseShares,
  BaseSummary,
  BaseTable,
  BulkRecordsInput,
  BulkResult,
  CreateBaseInput,
  CreateFieldInput,
  CreateRecordInput,
  CreateViewInput,
  Field,
  RecordActivity,
  RecordDetail,
  RecordFile,
  RecordPage,
  RecordsQuery,
  RecordTitle,
  RecordValues,
  TableRecord,
  TrashItem,
  UpdateBaseInput,
  UpdateFieldInput,
  UpdateTableInput,
  UpdateViewInput,
  View,
} from './tables.js';

const path = (kind: 'bases' | 'tables' | 'fields' | 'views' | 'records', id: string, rest = '') =>
  `/api/tables/${kind}/${encodeURIComponent(id)}${rest}`;

export function tablesApi(http: KnowledgeHttp) {
  return {
    bases: {
      /** Mine and those shared with me, with their tables and the views I see; `archived` lists the archived ones I own. */
      list: (query: { archived?: boolean } = {}) =>
        http.get<{ items: BaseSummary[] }>('/api/tables/bases', {
          archived: query.archived === undefined ? undefined : String(query.archived),
        }),
      get: (id: string) => http.get<Base>(path('bases', id)),
      /** Blank (one table, one view) or from a template. */
      create: (input: CreateBaseInput) => http.post<Base>('/api/tables/bases', input),
      /** Rename, describe, or pin for me. */
      update: (id: string, input: UpdateBaseInput) => http.patch<Base>(path('bases', id), input),
      archive: (id: string) => http.post<Base>(path('bases', id, '/archive')),
      restore: (id: string) => http.post<Base>(path('bases', id, '/restore')),
      /** For good: the name typed again. */
      remove: (id: string, name: string) => http.post<void>(path('bases', id, '/delete'), { name }),
      shares: (id: string) => http.get<BaseShares>(path('bases', id, '/share')),
      share: (id: string, input: BaseShareInput) => http.put<BaseShares>(path('bases', id, '/share'), input),
      /** Deleted records, deleted fields and data tables, newest first. */
      trash: (id: string, query: { cursor?: string; limit?: number } = {}) =>
        http.get<Page<TrashItem>>(path('bases', id, '/trash'), query),
      audit: (id: string, query: { cursor?: string; limit?: number } = {}) =>
        http.get<Page<BaseAuditEntry>>(path('bases', id, '/audit'), query),
      /** A file for an attachment field; it joins a record when a change names it. */
      upload(id: string, file: Blob & { name?: string }): Promise<RecordFile> {
        const form = new FormData();
        form.set('file', file, file.name ?? 'file');
        return http.request<RecordFile>('POST', path('bases', id, '/files'), undefined, { raw: form });
      },
      createTable: (id: string, name: string) => http.post<BaseTable>(path('bases', id, '/tables'), { name }),
    },

    tables: {
      update: (id: string, input: UpdateTableInput) => http.patch<BaseTable>(path('tables', id), input),
      archive: (id: string) => http.del(path('tables', id)),
      restore: (id: string) => http.post<BaseTable>(path('tables', id, '/restore')),
      purge: (id: string) => http.post<void>(path('tables', id, '/purge')),
      /** Record titles for pickers, best match first. */
      titles: (id: string, query: { q?: string; limit?: number } = {}) =>
        http.get<{ items: RecordTitle[] }>(path('tables', id, '/titles'), query),
      /** The records of a view (its filter, sorts and visible fields) or of the whole table, as CSV. */
      export: (id: string, viewId?: string) => http.downloadBlob(path('tables', id, '/export'), { view_id: viewId }),
      createField: (id: string, input: CreateFieldInput) => http.post<Field>(path('tables', id, '/fields'), input),
      createView: (id: string, input: CreateViewInput) => http.post<View>(path('tables', id, '/views'), input),
      query: (id: string, query: RecordsQuery) => http.post<RecordPage>(path('tables', id, '/records/query'), query),
      createRecord: (id: string, input: CreateRecordInput) =>
        http.post<RecordDetail>(path('tables', id, '/records'), input),
      /** A paste: each item changes or creates one record, and fails on its own. */
      bulk: (id: string, input: BulkRecordsInput) => http.post<BulkResult>(path('tables', id, '/records/bulk'), input),
      /** To the recycle bin. */
      deleteRecords: (id: string, ids: string[]) =>
        http.post<{ deleted: number }>(path('tables', id, '/records/delete'), { ids }),
    },

    fields: {
      update: (id: string, input: UpdateFieldInput) => http.patch<Field>(path('fields', id), input),
      archive: (id: string) => http.del(path('fields', id)),
      restore: (id: string) => http.post<Field>(path('fields', id, '/restore')),
      purge: (id: string) => http.post<void>(path('fields', id, '/purge')),
    },

    views: {
      /** Send the revision it is based on; a newer one answers 409 `stale_revision`. */
      update: (id: string, input: UpdateViewInput) => http.patch<View>(path('views', id), input),
      remove: (id: string) => http.del(path('views', id)),
    },

    records: {
      get: (id: string) => http.get<RecordDetail>(path('records', id)),
      /** Send the revision it is based on; a newer one answers 409 `stale_revision` with the record now. */
      update: (id: string, revision: number, values: RecordValues) =>
        http.patch<RecordDetail>(path('records', id), { revision, values }),
      remove: (id: string) => http.del(path('records', id)),
      restore: (id: string) => http.post<TableRecord>(path('records', id, '/restore')),
      purge: (id: string) => http.post<void>(path('records', id, '/purge')),
      activity: (id: string, query: { cursor?: string; limit?: number } = {}) =>
        http.get<RecordActivity>(path('records', id, '/activity'), query),
      comment: (id: string, body: string) => http.post<KnowledgeComment>(path('records', id, '/comments'), { body }),
      editComment: (id: string, commentId: string, body: string) =>
        http.patch<KnowledgeComment>(path('records', id, `/comments/${encodeURIComponent(commentId)}`), { body }),
      removeComment: (id: string, commentId: string) =>
        http.del(path('records', id, `/comments/${encodeURIComponent(commentId)}`)),
    },

    forms: formsApi(http),
    imports: importsApi(http),
    cards: cardsApi(http),
  };
}
