/**
 * Report template calls (`/api/report-templates`, plugins/reports/api/routes/report-templates.ts):
 * the templates I can see (the team's and my drafts), create, update (the whole definition plus
 * visibility), soft delete, and a sample PDF of a definition that is not saved.
 */

import { api, del, get, post, put, seg } from '../../api/client';
import type { ReportTemplateView } from '../../shared/reports';
import type { TemplateDraft } from './template-draft';

export const listTemplates = () => get<{ templates: ReportTemplateView[] }>('/api/report-templates');

export const createTemplate = (body: TemplateDraft) =>
  post<{ template: ReportTemplateView }>('/api/report-templates', body);

export const updateTemplate = (id: string, body: TemplateDraft) =>
  put<{ template: ReportTemplateView }>(`/api/report-templates/${seg(id)}`, body);

export const deleteTemplate = (id: string) => del<{ deleted: true; id: string }>(`/api/report-templates/${seg(id)}`);

/** The definition rendered with sample content as a PDF; the reason when the station refuses. */
export async function previewTemplate(body: TemplateDraft, locale: 'zh' | 'en'): Promise<Blob | string> {
  try {
    const res = await api('/api/report-templates/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: body, locale }),
    });
    if (res.ok) return await res.blob();
    const answer = (await res.json().catch(() => null)) as { error?: string } | null;
    return answer?.error || `HTTP ${res.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
