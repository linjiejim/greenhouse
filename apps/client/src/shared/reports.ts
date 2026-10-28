// VENDORED from packages/types/src/reports.ts — verbatim below this header.
// Change the canonical file, re-copy it, and run src/shared/vendor.parity.test.ts.
// apps/client cannot import workspace packages (see apps/client/AGENTS.md).

/**
 * Report templates (v1.7) — the team's required shape for reports and decks.
 *
 * A template says what a report must contain (ordered sections, each with
 * guidance for whoever writes it and the kind of content it expects), which
 * cover fields it carries and which file formats it may be rendered to. Any
 * agent — a member's Codex over MCP, or the in-app assistant — reads the
 * template, writes structured content, and the server renders it in the
 * workspace brand. Shared by the reports plugin's storage, validation and
 * rendering, so they can never disagree on a limit.
 *
 * Identity and rules only: no display copy.
 */

export const REPORT_KINDS = ['report', 'presentation'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_FORMATS = ['pdf', 'docx', 'pptx'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** Which output formats each kind may be rendered to; the first is the default. */
export const REPORT_FORMATS_BY_KIND: Record<ReportKind, readonly ReportFormat[]> = {
  report: ['pdf', 'docx'],
  presentation: ['pptx', 'pdf'],
};

/** What a section's content looks like. */
export const REPORT_SECTION_CONTENT_KINDS = ['markdown', 'bullets', 'table', 'figures'] as const;
export type ReportSectionContentKind = (typeof REPORT_SECTION_CONTENT_KINDS)[number];

export const REPORT_COVER_FIELD_KEYS = ['title', 'subtitle', 'author', 'date', 'period'] as const;
export type ReportCoverFieldKey = (typeof REPORT_COVER_FIELD_KEYS)[number];

/** `team`: every member sees it. `personal`: a draft only its owner sees. */
export const REPORT_TEMPLATE_VISIBILITIES = ['team', 'personal'] as const;
export type ReportTemplateVisibility = (typeof REPORT_TEMPLATE_VISIBILITIES)[number];

export interface ReportTemplateSection {
  /** Stable key the content is addressed by (`summary`, `next_steps`). */
  key: string;
  title: string;
  /** What to write here — read by the agent (or person) writing the report. */
  guidance: string;
  required: boolean;
  content: ReportSectionContentKind;
}

export interface ReportTemplateCoverField {
  key: ReportCoverFieldKey;
  required: boolean;
}

/** The editable part of a template. */
export interface ReportTemplateDefinition {
  name: string;
  description: string;
  kind: ReportKind;
  formats: ReportFormat[];
  sections: ReportTemplateSection[];
  cover_fields: ReportTemplateCoverField[];
}

/** A stored template as the API returns it. */
export interface ReportTemplateView extends ReportTemplateDefinition {
  id: string;
  visibility: ReportTemplateVisibility;
  owner_user_id: string | null;
  owner_name: string | null;
  /** Bumped on every edit; a rendered file names the version it was made from. */
  version: number;
  /** Shipped with Greenhouse (seeded on first boot); edited and deleted like any other. */
  is_default: boolean;
  created_at: string;
  updated_at: string;
  /** Whether the caller may edit or delete it (owner, or a super for team templates). */
  can_edit: boolean;
}

export const REPORT_TEMPLATE_LIMITS = {
  name: 80,
  description: 500,
  sections: 30,
  sectionKey: 40,
  sectionTitle: 120,
  guidance: 2000,
} as const;

/** Size limits on the content of one render. */
export const REPORT_CONTENT_LIMITS = {
  coverField: 200,
  markdownChars: 20_000,
  totalChars: 200_000,
  bullets: 100,
  bulletChars: 1_000,
  tableColumns: 12,
  tableRows: 200,
  cellChars: 500,
  figures: 12,
  figureLabel: 80,
  figureValue: 40,
  figureNote: 200,
  fileName: 120,
} as const;

export const REPORT_SECTION_KEY_RE = /^[a-z][a-z0-9_]*$/;

export type ReportTemplateCheck = { ok: true; value: ReportTemplateDefinition } | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Check and normalize a template definition (trimmed strings, formats in
 * canonical order, booleans coerced). Every problem is reported, not just the
 * first, so a form can show them all at once.
 */
export function checkReportTemplateDefinition(input: unknown): ReportTemplateCheck {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['The template must be an object.'] };
  const L = REPORT_TEMPLATE_LIMITS;

  const name = text(input.name);
  if (!name) errors.push('name is required.');
  else if (name.length > L.name) errors.push(`name is longer than ${L.name} characters.`);

  const description = text(input.description);
  if (description.length > L.description) errors.push(`description is longer than ${L.description} characters.`);

  const kind = REPORT_KINDS.find((k) => k === input.kind);
  if (!kind) errors.push(`kind must be one of: ${REPORT_KINDS.join(', ')}.`);

  const allowed = kind ? REPORT_FORMATS_BY_KIND[kind] : REPORT_FORMATS;
  const rawFormats = Array.isArray(input.formats) ? input.formats : [];
  const unknownFormats = rawFormats.filter((f) => !allowed.includes(f as ReportFormat));
  if (unknownFormats.length) {
    errors.push(`formats for a ${kind ?? 'template'} may only be: ${allowed.join(', ')}.`);
  }
  const formats = allowed.filter((f) => rawFormats.includes(f));
  if (formats.length === 0 && unknownFormats.length === 0) errors.push('Pick at least one output format.');

  const rawSections = Array.isArray(input.sections) ? input.sections : [];
  if (rawSections.length === 0) errors.push('A template needs at least one section.');
  if (rawSections.length > L.sections) errors.push(`A template has at most ${L.sections} sections.`);
  const seen = new Set<string>();
  const sections: ReportTemplateSection[] = [];
  rawSections.slice(0, L.sections).forEach((raw, index) => {
    const at = `Section ${index + 1}`;
    if (!isRecord(raw)) {
      errors.push(`${at} must be an object.`);
      return;
    }
    const key = text(raw.key);
    if (!key) errors.push(`${at}: key is required.`);
    else if (key.length > L.sectionKey || !REPORT_SECTION_KEY_RE.test(key)) {
      errors.push(
        `${at}: key "${key}" must start with a lowercase letter and use only a-z, 0-9 and _ (at most ${L.sectionKey}).`,
      );
    } else if (seen.has(key)) errors.push(`${at}: key "${key}" is used twice.`);
    seen.add(key);
    const title = text(raw.title);
    if (!title) errors.push(`${at}: title is required.`);
    else if (title.length > L.sectionTitle) errors.push(`${at}: title is longer than ${L.sectionTitle} characters.`);
    const guidance = text(raw.guidance);
    if (guidance.length > L.guidance) errors.push(`${at}: guidance is longer than ${L.guidance} characters.`);
    const content = REPORT_SECTION_CONTENT_KINDS.find((c) => c === raw.content);
    if (!content) errors.push(`${at}: content must be one of: ${REPORT_SECTION_CONTENT_KINDS.join(', ')}.`);
    sections.push({ key, title, guidance, required: raw.required === true, content: content ?? 'markdown' });
  });

  const rawCover = Array.isArray(input.cover_fields) ? input.cover_fields : [];
  const cover_fields: ReportTemplateCoverField[] = [];
  for (const raw of rawCover) {
    const key = isRecord(raw) ? REPORT_COVER_FIELD_KEYS.find((k) => k === raw.key) : undefined;
    if (!key) {
      errors.push(`cover_fields may only use: ${REPORT_COVER_FIELD_KEYS.join(', ')}.`);
      continue;
    }
    if (cover_fields.some((field) => field.key === key)) {
      errors.push(`cover field "${key}" is listed twice.`);
      continue;
    }
    cover_fields.push({ key, required: isRecord(raw) && raw.required === true });
  }

  if (errors.length || !kind) return { ok: false, errors };
  return { ok: true, value: { name, description, kind, formats, sections, cover_fields } };
}
