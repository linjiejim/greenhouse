/** The imports calls of the typed client (`client.tables.imports`). */

import type { Page } from './common.js';
import type { KnowledgeHttp } from './knowledge-client.js';
import type { BaseImport, UpdateImportInput } from './tables-imports.js';

const one = (id: string, rest = '') => `/api/tables/imports/${encodeURIComponent(id)}${rest}`;
const ofTable = (tableId: string) => `/api/tables/tables/${encodeURIComponent(tableId)}/imports`;

export function importsApi(http: KnowledgeHttp) {
  return {
    /** A CSV file for a data table: read, and kept as a draft for a day with a suggested mapping. */
    upload(tableId: string, file: Blob & { name?: string }): Promise<BaseImport> {
      const form = new FormData();
      form.set('file', file, file.name ?? 'import.csv');
      return http.request<BaseImport>('POST', ofTable(tableId), undefined, { raw: form });
    },
    /** My imports into a data table, newest first. */
    list: (tableId: string, query: { cursor?: string; limit?: number } = {}) =>
      http.get<Page<BaseImport>>(ofTable(tableId), query),
    /** One import, with its progress and, once finished, what it created and skipped. */
    get: (id: string) => http.get<BaseImport>(one(id)),
    /** A draft's mapping, or whether its first row is the header. */
    update: (id: string, input: UpdateImportInput) => http.patch<BaseImport>(one(id), input),
    /** Queues a draft: its rows are written in the background. */
    start: (id: string) => http.post<BaseImport>(one(id, '/start')),
    /** Stops it at its next batch; the rows already written stay. */
    cancel: (id: string) => http.post<BaseImport>(one(id, '/cancel')),
  };
}
