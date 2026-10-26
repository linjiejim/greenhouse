/**
 * Render a report from a template and save it to Files — the one
 * implementation behind `report_render` (MCP, Agent API, Chat), plus the
 * dry-run check `report_templates` exposes as `validate` and the editor's
 * preview.
 *
 * The file goes to the member's personal shelf unless they name the team
 * shelf or a folder they may write; drive/kb-cabinet.ts authorizes it and
 * records the upload like any other. Rendering is local: no provider call,
 * nothing metered.
 */

import type { DatabaseProvider } from '@greenhouse/api/extension-kit';
import type { ActorContext } from '@greenhouse/api/extension-kit';
import { REPORT_CONTENT_LIMITS, type ReportTemplateView } from '@greenhouse/types/reports';
import type { FilesShelf } from '@greenhouse/types/files';
import {
  cabinetDownloadUrl,
  MAX_AGENT_UPLOAD_BYTES,
  uploadCabinetFile,
  type CabinetFileView,
} from '@greenhouse/api/extension-kit';
import { resolveReportBrand, type ReportBrand } from './brand.js';
import {
  checkReportContent,
  type ReportContentInput,
  type ReportContentIssue,
  type ReportDocument,
} from './content.js';
import { renderReport } from './render.js';
import { getTemplate, type TemplateActor } from './templates.js';

export interface ReportCaller extends TemplateActor {
  db: DatabaseProvider;
  /** Who the Files audit row names (the member, or the agent acting for them). */
  actor: ActorContext;
}

export interface RenderReportInput extends ReportContentInput {
  template_id: string;
  file_name?: string;
  shelf?: FilesShelf;
  folder_id?: string | null;
}

/** A refusal names at most this many problems (each is one line). */
const MAX_LISTED_ISSUES = 25;

/** The template's outline, attached to a refusal so the writer can fix it without another lookup. */
function outline(template: ReportTemplateView) {
  return {
    id: template.id,
    name: template.name,
    formats: template.formats,
    cover_fields: template.cover_fields,
    sections: template.sections.map(({ key, title, required, content }) => ({ key, title, required, content })),
  };
}

export type ReportCheckResult =
  | { ok: true; template: ReportTemplateView; document: ReportDocument }
  | { ok: false; error: string; issues?: ReportContentIssue[]; template?: ReturnType<typeof outline> };

/** Look the template up as the caller and check content against it. */
export async function checkReport(caller: ReportCaller, input: RenderReportInput): Promise<ReportCheckResult> {
  const found = await getTemplate(caller.db, caller, input.template_id);
  if (!found.ok) return { ok: false, error: found.error };
  const template = found.value;
  const checked = checkReportContent(template, input);
  if (!checked.ok) {
    // The issues are spelled out in the message itself: over MCP a refused
    // write reaches the agent as this one string.
    const shown = checked.issues.slice(0, MAX_LISTED_ISSUES);
    const more = checked.issues.length - shown.length;
    const error =
      `The content does not fit template "${template.name}" (${checked.issues.length} problem${checked.issues.length === 1 ? '' : 's'}). ` +
      `Fix all of them and call again:\n${shown.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n')}` +
      (more > 0 ? `\n- …and ${more} more of the same kind.` : '') +
      `\nSections of this template: ${template.sections.map((s) => `${s.key}${s.required ? ' (required)' : ''} = ${s.content}`).join(', ')}.`;
    return { ok: false, error, issues: checked.issues, template: outline(template) };
  }
  return { ok: true, template, document: checked.document };
}

const ILLEGAL_NAME = /[\\/:*?"<>|]+/g;

/** `<title> <date|period>.<ext>`, or the caller's name with the right extension. */
export function reportFileName(document: ReportDocument, extension: string, requested?: string): string {
  const base =
    (requested ?? '').trim().replace(/\.(pdf|docx|pptx)$/i, '') ||
    [document.cover.title, document.cover.date ?? document.cover.period ?? new Date().toISOString().slice(0, 10)]
      .filter(Boolean)
      .join(' ');
  const printable = [...base].filter((char) => char.charCodeAt(0) >= 0x20).join('');
  const clean = printable
    .replace(ILLEGAL_NAME, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REPORT_CONTENT_LIMITS.fileName);
  return `${clean || 'report'}.${extension}`;
}

export type RenderReportResult =
  | {
      success: true;
      file_id: string;
      file: CabinetFileView;
      format: string;
      template: { id: string; name: string; version: number };
      size_bytes: number;
      download_url: string | null;
      download_expires_in_seconds?: number;
      download_note?: string;
      warnings?: string[];
    }
  | { error: string; issues?: ReportContentIssue[]; template?: ReturnType<typeof outline> };

export async function renderReportToFiles(
  caller: ReportCaller,
  input: RenderReportInput,
  brand?: ReportBrand,
): Promise<RenderReportResult> {
  const checked = await checkReport(caller, input);
  if (!checked.ok) return { error: checked.error, issues: checked.issues, template: checked.template };
  const rendered = await renderReport(checked.document, brand ?? (await resolveReportBrand()));
  if (rendered.bytes.length > MAX_AGENT_UPLOAD_BYTES) {
    return {
      error: `The rendered file is ${Math.ceil(rendered.bytes.length / 1024 / 1024)} MB; Files takes up to ${MAX_AGENT_UPLOAD_BYTES / 1024 / 1024} MB from an agent. Shorten the content and try again.`,
    };
  }
  const cabinet = { db: caller.db, userId: caller.userId, actor: caller.actor };
  const uploaded = await uploadCabinetFile(cabinet, {
    shelf: input.shelf ?? 'personal',
    folderId: input.folder_id ?? null,
    name: reportFileName(checked.document, rendered.extension, input.file_name),
    bytes: rendered.bytes,
  });
  if ('error' in uploaded) return { error: `The report was rendered but not saved: ${uploaded.error}` };
  const link = await cabinetDownloadUrl(cabinet, uploaded.file.id);
  return {
    success: true,
    file_id: uploaded.file.id,
    file: uploaded.file,
    format: rendered.extension,
    template: checked.document.template,
    size_bytes: rendered.bytes.length,
    ...('error' in link
      ? { download_url: null, download_note: 'No direct link on this deployment; open it from the Files page.' }
      : { download_url: link.download_url, download_expires_in_seconds: link.expires_in_seconds }),
    ...(rendered.warnings.length ? { warnings: rendered.warnings } : {}),
  };
}
