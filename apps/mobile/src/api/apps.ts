import type { AppSummary, AppRuntime, AppCardAnswer, Page, RecordDetail } from '../shared/contract';
import { get, post, seg } from './client';

const path = (id: string) => `/api/apps/${seg(id)}`;
export const apps = (query: { cursor?: string; q?: string } = {}) => get<Page<AppSummary>>('/api/apps', query);
export const appRuntime = (id: string) => get<AppRuntime>(path(id));
export const appCard = (id: string, version: number, card: string, cursor?: string) =>
  post<AppCardAnswer>(`${path(id)}/cards/query`, { version, card, cursor });
export const appRecord = (id: string, version: number, card: string, record: string) =>
  post<RecordDetail>(`${path(id)}/cards/${seg(card)}/records/${seg(record)}`, { version });
export const appExecute = (
  id: string,
  input: {
    version: number;
    card: string;
    action: string;
    record_id?: string;
    revision?: number;
    values?: Record<string, unknown>;
  },
) => post<RecordDetail>(`${path(id)}/actions`, input);
