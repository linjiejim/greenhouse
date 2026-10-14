import type { z } from 'zod';
import type { KnowledgeHttp } from './knowledge-client.js';
import type { Page } from './common.js';
import type {
  AppDraft,
  AppRuntime,
  AppSummary,
  AppVersion,
  AppTemplate,
  appCreateSchema,
  appDraftSchema,
  appExecuteSchema,
  appPublishSchema,
  templateSaveSchema,
} from './apps.js';
import type { Base, RecordDetail, RecordPage } from './tables.js';
import type { CardData } from './tables-cards.js';
export type AppCardAnswer =
  | { kind: 'chart'; data: CardData }
  | { kind: 'records'; data: RecordPage }
  | { kind: 'empty' };
export function appsApi(http: KnowledgeHttp) {
  const path = (id: string) => `/api/apps/${encodeURIComponent(id)}`;
  const query = (input: { cursor?: string; limit?: number; q?: string }) => {
    const out = new URLSearchParams();
    for (const [key, value] of Object.entries(input)) if (value !== undefined) out.set(key, String(value));
    return out.toString();
  };
  return {
    list: (input: { cursor?: string; limit?: number; q?: string } = {}) =>
      http.get<Page<AppSummary>>(`/api/apps?${query(input)}`),
    create: (input: z.input<typeof appCreateSchema>) => http.post<AppDraft>('/api/apps', input),
    draft: (id: string) => http.get<AppDraft>(`${path(id)}/draft`),
    save: (id: string, input: z.input<typeof appDraftSchema>) => http.put<AppDraft>(`${path(id)}/draft`, input),
    publish: (id: string, input: z.input<typeof appPublishSchema>) => http.post<AppDraft>(`${path(id)}/publish`, input),
    versions: (id: string, input: { cursor?: string; limit?: number } = {}) =>
      http.get<Page<AppVersion>>(`${path(id)}/versions?${query(input)}`),
    restore: (id: string, revision: number, version: number) =>
      http.post<AppDraft>(`${path(id)}/restore`, { revision, version }),
    runtime: (id: string, previewRole?: string) =>
      http.get<AppRuntime>(`${path(id)}${previewRole ? `?preview_role=${encodeURIComponent(previewRole)}` : ''}`),
    card: (id: string, version: number, card: string, cursor?: string, previewRole?: string) =>
      http.post<AppCardAnswer>(`${path(id)}/cards/query`, { version, card, cursor, preview_role: previewRole }),
    record: (id: string, version: number, card: string, record: string, previewRole?: string) =>
      http.post<RecordDetail>(`${path(id)}/cards/${encodeURIComponent(card)}/records/${encodeURIComponent(record)}`, {
        version,
        preview_role: previewRole,
      }),
    execute: (id: string, input: z.input<typeof appExecuteSchema>) =>
      http.post<RecordDetail>(`${path(id)}/actions`, input),
    pin: (id: string, value: boolean) => http.put<void>(`${path(id)}/pin`, { value }),
    feature: (id: string, value: boolean) => http.put<void>(`${path(id)}/featured`, { value }),
    templates: {
      list: (input: { cursor?: string; limit?: number } = {}) =>
        http.get<Page<AppTemplate>>(`/api/apps/templates?${query(input)}`),
      get: (id: string) =>
        http.get<{ template: AppTemplate; content: unknown; content_hash: string; changelog: string }>(
          `/api/apps/templates/${encodeURIComponent(id)}`,
        ),
      save: (id: string, input: z.input<typeof templateSaveSchema>) =>
        http.post<AppTemplate>(`${path(id)}/templates`, input),
      review: (id: string, decision: 'approved' | 'rejected') =>
        http.post<AppTemplate>(`/api/apps/templates/${encodeURIComponent(id)}/review`, { decision }),
      install: (id: string, name?: string) =>
        http.post<{ base: Base; app: AppDraft | null }>(`/api/apps/templates/${encodeURIComponent(id)}/install`, {
          name,
        }),
    },
  };
}
