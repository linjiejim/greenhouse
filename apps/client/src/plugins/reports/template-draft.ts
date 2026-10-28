/**
 * Report template editor rules, pure (./template-draft.test.ts): the draft the browser editor
 * holds, the body `POST`/`PUT /api/report-templates` takes, and the problems the station would
 * name, checked with the station's own rule (src/shared/reports.ts, vendored verbatim). Who may
 * edit, publish or keep a draft stays the station's (plugins/reports/api/templates.ts).
 */

import {
  checkReportTemplateDefinition,
  REPORT_FORMATS_BY_KIND,
  REPORT_TEMPLATE_LIMITS,
  type ReportFormat,
  type ReportKind,
  type ReportTemplateDefinition,
  type ReportTemplateSection,
  type ReportTemplateView,
  type ReportTemplateVisibility,
} from '../../shared/reports';

export interface TemplateDraft extends ReportTemplateDefinition {
  visibility: ReportTemplateVisibility;
}

export function draftOf(view?: ReportTemplateView): TemplateDraft {
  if (view)
    return {
      name: view.name,
      description: view.description,
      kind: view.kind,
      formats: [...view.formats],
      sections: view.sections.map((section) => ({ ...section })),
      cover_fields: view.cover_fields.map((field) => ({ ...field })),
      visibility: view.visibility,
    };
  return {
    name: '',
    description: '',
    kind: 'report',
    formats: [...REPORT_FORMATS_BY_KIND.report],
    sections: [{ key: 'summary', title: '', guidance: '', required: true, content: 'markdown' }],
    cover_fields: [{ key: 'title', required: true }],
    visibility: 'team',
  };
}

/** A new kind keeps the formats it still allows, else its default. */
export function withKind(draft: TemplateDraft, kind: ReportKind): TemplateDraft {
  const allowed = REPORT_FORMATS_BY_KIND[kind];
  const kept = allowed.filter((format) => draft.formats.includes(format));
  return { ...draft, kind, formats: kept.length ? kept : [allowed[0]!] };
}

/** Formats stay in the kind's canonical order (the first is the default). */
export function toggleFormat(draft: TemplateDraft, format: ReportFormat): TemplateDraft {
  const on = draft.formats.includes(format);
  const next = on ? draft.formats.filter((f) => f !== format) : [...draft.formats, format];
  return { ...draft, formats: REPORT_FORMATS_BY_KIND[draft.kind].filter((f) => next.includes(f)) };
}

/** An empty section with a key no other section uses. */
export function addSection(draft: TemplateDraft): TemplateDraft {
  if (draft.sections.length >= REPORT_TEMPLATE_LIMITS.sections) return draft;
  const keys = new Set(draft.sections.map((section) => section.key));
  let n = draft.sections.length + 1;
  while (keys.has(`section_${n}`)) n += 1;
  const section: ReportTemplateSection = {
    key: `section_${n}`,
    title: '',
    guidance: '',
    required: false,
    content: 'markdown',
  };
  return { ...draft, sections: [...draft.sections, section] };
}

export function moveSection(draft: TemplateDraft, index: number, by: -1 | 1): TemplateDraft {
  const to = index + by;
  if (to < 0 || to >= draft.sections.length) return draft;
  const sections = [...draft.sections];
  [sections[index], sections[to]] = [sections[to]!, sections[index]!];
  return { ...draft, sections };
}

export function updateSection(
  draft: TemplateDraft,
  index: number,
  patch: Partial<ReportTemplateSection>,
): TemplateDraft {
  return { ...draft, sections: draft.sections.map((section, i) => (i === index ? { ...section, ...patch } : section)) };
}

export function removeSection(draft: TemplateDraft, index: number): TemplateDraft {
  return { ...draft, sections: draft.sections.filter((_, i) => i !== index) };
}

/** Every problem the station would name, at once (empty = it would accept the definition). */
export function draftProblems(draft: TemplateDraft): string[] {
  const checked = checkReportTemplateDefinition(draft);
  return checked.ok ? [] : checked.errors;
}

/** The write body: the definition plus where it lives. */
export function templateBody(draft: TemplateDraft): TemplateDraft {
  return {
    name: draft.name,
    description: draft.description,
    kind: draft.kind,
    formats: draft.formats,
    sections: draft.sections,
    cover_fields: draft.cover_fields,
    visibility: draft.visibility,
  };
}
