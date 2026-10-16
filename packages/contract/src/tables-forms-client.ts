/** The forms calls of the typed client (`client.tables.forms`). */

import type { Page } from './common.js';
import type { KnowledgeHttp } from './knowledge-client.js';
import type {
  CreateFormInput,
  Form,
  FormFill,
  FormReceipt,
  FormShareInput,
  FormShares,
  FormSubmission,
  FormUpload,
  UpdateFormInput,
} from './tables-forms.js';
import type { RecordValues } from './tables.js';

const at = (id: string, rest = '') => `/api/tables/forms/${encodeURIComponent(id)}${rest}`;

export function formsApi(http: KnowledgeHttp) {
  return {
    /** A data table's forms (builders). */
    list: (tableId: string) => http.get<{ items: Form[] }>(`/api/tables/tables/${encodeURIComponent(tableId)}/forms`),
    /** A draft; without `config` it asks for the table's fields. */
    create: (tableId: string, input: CreateFormInput) =>
      http.post<Form>(`/api/tables/tables/${encodeURIComponent(tableId)}/forms`, input),
    get: (id: string) => http.get<Form>(at(id)),
    /** Send the revision it is based on; a newer one answers 409 `stale_revision`. */
    update: (id: string, input: UpdateFormInput) => http.patch<Form>(at(id), input),
    /** With its submissions; the records they added stay. */
    remove: (id: string) => http.del(at(id)),
    publish: (id: string) => http.post<Form>(at(id, '/publish')),
    unpublish: (id: string) => http.post<Form>(at(id, '/unpublish')),
    /** Who may submit; empty: the members who may add records to its table. */
    shares: (id: string) => http.get<FormShares>(at(id, '/share')),
    share: (id: string, input: FormShareInput) => http.put<FormShares>(at(id, '/share'), input),
    /** Newest first (editors). */
    submissions: (id: string, query: { cursor?: string; limit?: number } = {}) =>
      http.get<Page<FormSubmission>>(at(id, '/submissions'), query),
    /** What I fill in (a draft only for its builders). */
    fill: (id: string) => http.get<FormFill>(at(id, '/fill')),
    /** A file for one of its attachment fields; it joins the record when the submission names it. */
    upload(id: string, file: Blob & { name?: string }): Promise<FormUpload> {
      const form = new FormData();
      form.set('file', file, file.name ?? 'file');
      return http.request<FormUpload>('POST', at(id, '/files'), undefined, { raw: form });
    },
    submit: (id: string, values: RecordValues) => http.post<FormReceipt>(at(id, '/submissions'), { values }),
  };
}
