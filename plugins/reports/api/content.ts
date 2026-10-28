/**
 * Report content — what an agent writes against a template, and the check
 * that decides whether it can be rendered.
 *
 * The check is the contract with the writer: every problem is listed at once
 * (missing required sections, unknown keys, wrong shapes, sizes), each with
 * the path it concerns and a sentence saying what to do, so an agent can fix
 * everything and retry in one go. Content shapes per section kind:
 *
 *   markdown  "text"                     or { "markdown": "text" }
 *   bullets   ["one", "two"]             or { "bullets": [...] }
 *   table     { "columns": [...], "rows": [[...], ...] }
 *   figures   [{ "label", "value", "note"? }] or { "figures": [...] }
 *
 * An optional section that is absent or empty is left out of the document.
 */

import {
  REPORT_CONTENT_LIMITS as L,
  REPORT_COVER_FIELD_KEYS,
  type ReportCoverFieldKey,
  type ReportFormat,
  type ReportKind,
  type ReportSectionContentKind,
  type ReportTemplateDefinition,
} from '@greenhouse/types/reports';

export interface ReportFigure {
  label: string;
  value: string;
  note?: string;
}

export type ReportSectionBody =
  | { kind: 'markdown'; markdown: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'figures'; figures: ReportFigure[] };

export interface ReportDocument {
  template: { id: string; name: string; version: number };
  kind: ReportKind;
  format: ReportFormat;
  /** Always has a title (the template name when the writer gave none). */
  cover: Partial<Record<ReportCoverFieldKey, string>> & { title: string };
  sections: Array<{ key: string; title: string; body: ReportSectionBody }>;
}

export type ReportIssueProblem =
  | 'missing'
  | 'empty'
  | 'unknown_section'
  | 'wrong_shape'
  | 'too_long'
  | 'missing_cover_field'
  | 'unknown_cover_field'
  | 'unsupported_format';

export interface ReportContentIssue {
  /** Where: `sections.<key>`, `sections.<key>.rows[2]`, `cover.<field>`, `format`. */
  path: string;
  problem: ReportIssueProblem;
  message: string;
}

export interface ReportContentInput {
  format?: unknown;
  cover?: unknown;
  sections?: unknown;
}

export type ReportContentCheck = { ok: true; document: ReportDocument } | { ok: false; issues: ReportContentIssue[] };

export interface CheckableTemplate extends ReportTemplateDefinition {
  id: string;
  version: number;
}

const SHAPE_HINT: Record<ReportSectionContentKind, string> = {
  markdown: 'a Markdown string (or { "markdown": "..." })',
  bullets: 'an array of strings (or { "bullets": [...] })',
  table: '{ "columns": ["..."], "rows": [["..."]] }',
  figures: 'an array of { "label", "value", "note"? } (or { "figures": [...] })',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cellText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return '';
  return null;
}

/** Check content against a template; on success, the normalized document to render. */
export function checkReportContent(template: CheckableTemplate, input: ReportContentInput): ReportContentCheck {
  const issues: ReportContentIssue[] = [];
  const issue = (path: string, problem: ReportIssueProblem, message: string) => issues.push({ path, problem, message });
  let total = 0;

  // ── Format ──
  let format: ReportFormat = template.formats[0]!;
  if (input.format !== undefined && input.format !== null && input.format !== '') {
    const wanted = String(input.format).toLowerCase().replace(/^\./, '');
    const allowed = template.formats.find((f) => f === wanted);
    if (allowed) format = allowed;
    else
      issue(
        'format',
        'unsupported_format',
        `Template "${template.name}" renders to ${template.formats.join(' or ')}, not "${wanted}".`,
      );
  }

  // ── Cover ──
  const cover: Partial<Record<ReportCoverFieldKey, string>> = {};
  const coverKeys = template.cover_fields.map((field) => field.key);
  if (input.cover !== undefined && input.cover !== null && !isRecord(input.cover)) {
    issue('cover', 'wrong_shape', 'cover must be an object of cover fields.');
  }
  const rawCover = isRecord(input.cover) ? input.cover : {};
  for (const [key, value] of Object.entries(rawCover)) {
    const known = REPORT_COVER_FIELD_KEYS.find((k) => k === key);
    if (!known || !coverKeys.includes(known)) {
      issue(
        `cover.${key}`,
        'unknown_cover_field',
        coverKeys.length
          ? `This template's cover has ${coverKeys.join(', ')}; remove "${key}".`
          : `This template has no cover fields; remove "${key}".`,
      );
      continue;
    }
    const text = cellText(value);
    if (text === null) issue(`cover.${key}`, 'wrong_shape', `cover.${key} must be a string.`);
    else if (text.length > L.coverField)
      issue(`cover.${key}`, 'too_long', `cover.${key} is ${text.length} characters; at most ${L.coverField}.`);
    else if (text) {
      cover[known] = text;
      total += text.length;
    }
  }
  for (const field of template.cover_fields) {
    if (field.required && !cover[field.key] && !issues.some((i) => i.path === `cover.${field.key}`)) {
      issue(`cover.${field.key}`, 'missing_cover_field', `The cover needs "${field.key}".`);
    }
  }

  // ── Sections ──
  if (input.sections !== undefined && input.sections !== null && !isRecord(input.sections)) {
    issue('sections', 'wrong_shape', 'sections must be an object keyed by section key, e.g. { "summary": "..." }.');
  }
  const rawSections = isRecord(input.sections) ? input.sections : {};
  const known = new Set(template.sections.map((s) => s.key));
  for (const key of Object.keys(rawSections)) {
    if (!known.has(key)) {
      issue(
        `sections.${key}`,
        'unknown_section',
        `Template "${template.name}" has no section "${key}". Its sections are: ${[...known].join(', ')}.`,
      );
    }
  }

  const sections: ReportDocument['sections'] = [];
  for (const section of template.sections) {
    const path = `sections.${section.key}`;
    const raw = rawSections[section.key];
    const label = `"${section.key}" (${section.title})`;
    if (raw === undefined || raw === null) {
      if (section.required) {
        issue(path, 'missing', `Required section ${label} is missing. Write ${SHAPE_HINT[section.content]}.`);
      }
      continue;
    }
    const before = issues.length;
    const body = readBody(section.content, raw, path, label, issue);
    if (issues.length > before || !body) continue;
    if (bodyIsEmpty(body)) {
      if (section.required) issue(path, 'empty', `Required section ${label} is empty.`);
      continue;
    }
    total += bodyChars(body);
    sections.push({ key: section.key, title: section.title, body });
  }

  if (total > L.totalChars) {
    issue('sections', 'too_long', `The report has ${total} characters of content; at most ${L.totalChars}.`);
  }

  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    document: {
      template: { id: template.id, name: template.name, version: template.version },
      kind: template.kind,
      format,
      cover: { ...cover, title: cover.title ?? template.name },
      sections,
    },
  };
}

type IssueFn = (path: string, problem: ReportIssueProblem, message: string) => void;

function readBody(
  kind: ReportSectionContentKind,
  raw: unknown,
  path: string,
  label: string,
  issue: IssueFn,
): ReportSectionBody | null {
  const wrong = () => {
    issue(path, 'wrong_shape', `Section ${label} expects ${SHAPE_HINT[kind]}.`);
    return null;
  };
  switch (kind) {
    case 'markdown': {
      const text = typeof raw === 'string' ? raw : isRecord(raw) ? raw.markdown : undefined;
      if (typeof text !== 'string') return wrong();
      if (text.length > L.markdownChars) {
        issue(path, 'too_long', `Section ${label} is ${text.length} characters; at most ${L.markdownChars}.`);
        return null;
      }
      return { kind, markdown: text.trim() };
    }
    case 'bullets': {
      const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw.bullets : undefined;
      if (!Array.isArray(list)) return wrong();
      if (list.length > L.bullets) {
        issue(path, 'too_long', `Section ${label} has ${list.length} bullets; at most ${L.bullets}.`);
        return null;
      }
      const items: string[] = [];
      let ok = true;
      list.forEach((item, index) => {
        const text = cellText(item);
        if (text === null) {
          issue(`${path}[${index}]`, 'wrong_shape', `Bullet ${index + 1} of ${label} must be a string.`);
          ok = false;
        } else if (text.length > L.bulletChars) {
          issue(
            `${path}[${index}]`,
            'too_long',
            `Bullet ${index + 1} of ${label} is over ${L.bulletChars} characters.`,
          );
          ok = false;
        } else if (text) items.push(text);
      });
      return ok ? { kind, items } : null;
    }
    case 'table': {
      if (!isRecord(raw) || !Array.isArray(raw.columns) || !Array.isArray(raw.rows)) return wrong();
      const columns = raw.columns.map(cellText);
      if (columns.some((c) => c === null || c === '')) {
        issue(`${path}.columns`, 'wrong_shape', `Every column of ${label} needs a non-empty name.`);
        return null;
      }
      if (columns.length === 0 || columns.length > L.tableColumns) {
        issue(`${path}.columns`, 'too_long', `Table ${label} needs 1 to ${L.tableColumns} columns.`);
        return null;
      }
      if (raw.rows.length > L.tableRows) {
        issue(`${path}.rows`, 'too_long', `Table ${label} has ${raw.rows.length} rows; at most ${L.tableRows}.`);
        return null;
      }
      const rows: string[][] = [];
      let ok = true;
      raw.rows.forEach((row, index) => {
        const at = `${path}.rows[${index}]`;
        if (!Array.isArray(row)) {
          issue(at, 'wrong_shape', `Row ${index + 1} of ${label} must be an array of cells.`);
          ok = false;
          return;
        }
        if (row.length !== columns.length) {
          issue(
            at,
            'wrong_shape',
            `Row ${index + 1} of ${label} has ${row.length} cells; the table has ${columns.length} columns.`,
          );
          ok = false;
          return;
        }
        const cells = row.map(cellText);
        if (cells.some((c) => c === null)) {
          issue(at, 'wrong_shape', `Cells of ${label} must be strings or numbers (row ${index + 1}).`);
          ok = false;
        } else if (cells.some((c) => c!.length > L.cellChars)) {
          issue(at, 'too_long', `A cell in row ${index + 1} of ${label} is over ${L.cellChars} characters.`);
          ok = false;
        } else rows.push(cells as string[]);
      });
      return ok ? { kind, columns: columns as string[], rows } : null;
    }
    case 'figures': {
      const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw.figures : undefined;
      if (!Array.isArray(list)) return wrong();
      if (list.length > L.figures) {
        issue(path, 'too_long', `Section ${label} has ${list.length} figures; at most ${L.figures}.`);
        return null;
      }
      const figures: ReportFigure[] = [];
      let ok = true;
      list.forEach((item, index) => {
        const at = `${path}[${index}]`;
        const label2 = isRecord(item) ? cellText(item.label) : null;
        const value = isRecord(item) ? cellText(item.value) : null;
        const note = isRecord(item) && item.note !== undefined ? cellText(item.note) : '';
        if (!label2 || !value || note === null) {
          issue(
            at,
            'wrong_shape',
            `Figure ${index + 1} of ${label} needs a "label" and a "value" (and an optional "note").`,
          );
          ok = false;
        } else if (label2.length > L.figureLabel || value.length > L.figureValue || note.length > L.figureNote) {
          issue(
            at,
            'too_long',
            `Figure ${index + 1} of ${label}: label ≤ ${L.figureLabel}, value ≤ ${L.figureValue}, note ≤ ${L.figureNote} characters.`,
          );
          ok = false;
        } else figures.push(note ? { label: label2, value, note } : { label: label2, value });
      });
      return ok ? { kind, figures } : null;
    }
  }
}

function bodyIsEmpty(body: ReportSectionBody): boolean {
  switch (body.kind) {
    case 'markdown':
      return body.markdown === '';
    case 'bullets':
      return body.items.length === 0;
    case 'table':
      return body.rows.length === 0;
    case 'figures':
      return body.figures.length === 0;
  }
}

function bodyChars(body: ReportSectionBody): number {
  switch (body.kind) {
    case 'markdown':
      return body.markdown.length;
    case 'bullets':
      return body.items.reduce((n, item) => n + item.length, 0);
    case 'table':
      return body.columns.join('').length + body.rows.reduce((n, row) => n + row.join('').length, 0);
    case 'figures':
      return body.figures.reduce((n, f) => n + f.label.length + f.value.length + (f.note?.length ?? 0), 0);
  }
}

/** Every piece of text in a document, for glyph coverage checks. */
export function documentText(document: ReportDocument): string {
  const parts: string[] = [...Object.values(document.cover)];
  for (const section of document.sections) {
    parts.push(section.title);
    const body = section.body;
    if (body.kind === 'markdown') parts.push(body.markdown);
    else if (body.kind === 'bullets') parts.push(...body.items);
    else if (body.kind === 'table') parts.push(...body.columns, ...body.rows.flat());
    else parts.push(...body.figures.flatMap((f) => [f.label, f.value, f.note ?? '']));
  }
  return parts.join('\n');
}
