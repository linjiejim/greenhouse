/**
 * Report templates API — SkillHub › Report templates (v1.7). The team's
 * required report / deck formats; see apps/api/src/routes/report-templates.ts.
 * The preview returns PDF bytes, so it stays on raw authFetch.
 */
import type { ReportTemplateDefinition, ReportTemplateView, ReportTemplateVisibility } from '@greenhouse/types/reports';
import { authFetch } from '@greenhouse/web/extension-kit';
export type ReportTemplateInput = ReportTemplateDefinition & {
  visibility: ReportTemplateVisibility;
};
function errorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object' || !('error' in value)) return fallback;
  return typeof value.error === 'string' ? value.error : fallback;
}
export async function fetchReportTemplates(): Promise<ReportTemplateView[]> {
  const response = await authFetch('/api/report-templates');
  const data = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Unable to load report templates (${response.status})`));
  return data.templates as ReportTemplateView[];
}
export async function createReportTemplate(input: ReportTemplateInput): Promise<ReportTemplateView> {
  const response = await authFetch('/api/report-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok || !('template' in data)) {
    throw new Error(errorMessage(data, `Unable to save the template (${response.status})`));
  }
  return data.template;
}
export async function updateReportTemplate(id: string, input: ReportTemplateInput): Promise<ReportTemplateView> {
  const response = await authFetch(`/api/report-templates/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok || !('template' in data)) {
    throw new Error(errorMessage(data, `Unable to save the template (${response.status})`));
  }
  return data.template;
}
export async function deleteReportTemplate(id: string): Promise<void> {
  const response = await authFetch(`/api/report-templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) {
    const data = await response.json().catch(() => undefined);
    throw new Error(errorMessage(data, `Unable to delete the template (${response.status})`));
  }
}
/**
 * Render a template — a saved one by id, or an unsaved definition — with
 * sample content into a PDF, as a Blob for the preview dialog.
 */
export async function previewReportTemplate(
  source:
    | {
        template_id: string;
      }
    | {
        template: ReportTemplateDefinition;
      },
  locale: string,
): Promise<Blob> {
  const response = await authFetch('/api/report-templates/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...source, locale: locale.startsWith('zh') ? 'zh' : 'en' }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => undefined);
    throw new Error(errorMessage(data, `Unable to preview the template (${response.status})`));
  }
  const blob = await response.blob();
  return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
}
