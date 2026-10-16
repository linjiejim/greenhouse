import type {
  Base,
  BaseSummary,
  Page,
  RecordPage,
  RecordDetail,
  TableRecord,
  RecordActivity,
  Form,
  FormFill,
} from '../shared/contract';
import { get, patch, post, seg } from './client';
export const bases = (cursor?: string) => get<Page<BaseSummary>>('/api/tables/bases', { cursor });
export const base = (id: string) => get<Base>(`/api/tables/bases/${seg(id)}`);
export const records = (id: string, options: Record<string, unknown>) =>
  post<RecordPage>(`/api/tables/tables/${seg(id)}/records/query`, options);
export const record = (id: string) => get<RecordDetail>(`/api/tables/records/${seg(id)}`);
export const saveRecord = (id: string, revision: number, values: Record<string, unknown>) =>
  patch<TableRecord>(`/api/tables/records/${seg(id)}`, { revision, values });
export const activity = (id: string, cursor?: string) =>
  get<RecordActivity>(`/api/tables/records/${seg(id)}/activity`, { cursor });
export const commentRecord = (id: string, body: string) => post(`/api/tables/records/${seg(id)}/comments`, { body });
export const forms = (id: string) => get<{ items: Form[] }>(`/api/tables/tables/${seg(id)}/forms`);
export const fillForm = (id: string) => get<FormFill>(`/api/tables/forms/${seg(id)}/fill`);
export const submitForm = (id: string, values: Record<string, unknown>) =>
  post(`/api/tables/forms/${seg(id)}/submissions`, { values });
