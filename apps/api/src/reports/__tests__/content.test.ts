/**
 * The report content contract: a template definition is checked whole, and
 * content is checked against a template with every problem listed — missing
 * required sections, unknown keys, wrong shapes, sizes, cover fields, formats
 * — so an agent can fix everything and retry in one go.
 */

import { describe, expect, it } from 'vitest';
import { checkReportTemplateDefinition, REPORT_CONTENT_LIMITS } from '@greenhouse/types/reports';
import { checkReportContent, type CheckableTemplate } from '../content.js';
import { DEFAULT_REPORT_TEMPLATES } from '../defaults.js';

const template: CheckableTemplate = {
  id: 'rtpl_test',
  version: 3,
  name: 'Weekly',
  description: '',
  kind: 'report',
  formats: ['pdf', 'docx'],
  cover_fields: [
    { key: 'title', required: true },
    { key: 'period', required: false },
  ],
  sections: [
    { key: 'summary', title: 'Summary', guidance: '', required: true, content: 'markdown' },
    { key: 'metrics', title: 'Metrics', guidance: '', required: false, content: 'figures' },
    { key: 'risks', title: 'Risks', guidance: '', required: false, content: 'table' },
    { key: 'next', title: 'Next', guidance: '', required: true, content: 'bullets' },
  ],
};

describe('checkReportTemplateDefinition', () => {
  it('accepts the shipped defaults', () => {
    for (const definition of DEFAULT_REPORT_TEMPLATES) {
      expect(checkReportTemplateDefinition(definition).ok, definition.name).toBe(true);
    }
  });

  it('normalizes: trims, orders formats canonically, coerces required', () => {
    const checked = checkReportTemplateDefinition({
      name: '  Deck ',
      kind: 'presentation',
      formats: ['pdf', 'pptx'],
      sections: [{ key: 'a', title: ' A ', content: 'bullets', required: 'yes' }],
      cover_fields: [{ key: 'title', required: true }],
    });
    expect(checked).toEqual({
      ok: true,
      value: {
        name: 'Deck',
        description: '',
        kind: 'presentation',
        formats: ['pptx', 'pdf'],
        sections: [{ key: 'a', title: 'A', guidance: '', required: false, content: 'bullets' }],
        cover_fields: [{ key: 'title', required: true }],
      },
    });
  });

  it('lists every problem at once', () => {
    const checked = checkReportTemplateDefinition({
      name: '',
      kind: 'report',
      formats: ['pptx'],
      sections: [
        { key: 'Bad Key', title: 'x', content: 'markdown' },
        { key: 'ok', title: '', content: 'video' },
        { key: 'ok', title: 'dup', content: 'table' },
      ],
      cover_fields: [{ key: 'logo' }],
    });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.errors).toEqual(
      expect.arrayContaining([
        'name is required.',
        expect.stringContaining('formats for a report may only be: pdf, docx'),
        expect.stringContaining('key "Bad Key" must start with a lowercase letter'),
        'Section 2: title is required.',
        expect.stringContaining('Section 2: content must be one of'),
        'Section 3: key "ok" is used twice.',
        expect.stringContaining('cover_fields may only use'),
      ]),
    );
  });

  it('refuses an empty template', () => {
    const checked = checkReportTemplateDefinition({ name: 'x', kind: 'report', formats: ['pdf'], sections: [] });
    expect(checked).toEqual({ ok: false, errors: ['A template needs at least one section.'] });
  });
});

describe('checkReportContent', () => {
  it('normalizes accepted shapes and keeps template order', () => {
    const checked = checkReportContent(template, {
      cover: { title: '  W43  ', period: 'Oct' },
      sections: {
        next: { bullets: ['a', '', 'b'] },
        summary: '  **Done**  ',
        metrics: [{ label: 'Users', value: 42, note: '+5' }],
        risks: { columns: ['Risk', 'Owner'], rows: [['Fonts', 3]] },
      },
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.document).toEqual({
      template: { id: 'rtpl_test', name: 'Weekly', version: 3 },
      kind: 'report',
      format: 'pdf',
      cover: { title: 'W43', period: 'Oct' },
      sections: [
        { key: 'summary', title: 'Summary', body: { kind: 'markdown', markdown: '**Done**' } },
        {
          key: 'metrics',
          title: 'Metrics',
          body: { kind: 'figures', figures: [{ label: 'Users', value: '42', note: '+5' }] },
        },
        { key: 'risks', title: 'Risks', body: { kind: 'table', columns: ['Risk', 'Owner'], rows: [['Fonts', '3']] } },
        { key: 'next', title: 'Next', body: { kind: 'bullets', items: ['a', 'b'] } },
      ],
    });
  });

  it('leaves out an optional section that is absent or empty, and titles the cover with the template name', () => {
    const checked = checkReportContent(
      { ...template, cover_fields: [] },
      { sections: { summary: 'x', next: ['y'], metrics: [] } },
    );
    expect(checked.ok && checked.document.sections.map((s) => s.key)).toEqual(['summary', 'next']);
    expect(checked.ok && checked.document.cover.title).toBe('Weekly');
  });

  it('names a missing required section and an unknown key, with the shapes and keys to use', () => {
    const checked = checkReportContent(template, {
      cover: { title: 'W' },
      sections: { summary: 'x', blockers: ['?'] },
    });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.issues).toEqual([
      {
        path: 'sections.blockers',
        problem: 'unknown_section',
        message: 'Template "Weekly" has no section "blockers". Its sections are: summary, metrics, risks, next.',
      },
      {
        path: 'sections.next',
        problem: 'missing',
        message: 'Required section "next" (Next) is missing. Write an array of strings (or { "bullets": [...] }).',
      },
    ]);
  });

  it('refuses an empty required section, wrong shapes, bad rows and figures', () => {
    const checked = checkReportContent(template, {
      cover: { title: 'W' },
      sections: {
        summary: '   ',
        next: 'not a list',
        risks: { columns: ['A', 'B'], rows: [['1', '2'], ['only one']] },
        metrics: [{ label: 'x' }],
      },
    });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.issues.map((i) => [i.path, i.problem])).toEqual([
      ['sections.summary', 'empty'],
      ['sections.metrics[0]', 'wrong_shape'],
      ['sections.risks.rows[1]', 'wrong_shape'],
      ['sections.next', 'wrong_shape'],
    ]);
  });

  it('checks the cover and the format', () => {
    const checked = checkReportContent(template, {
      format: 'pptx',
      cover: { period: 'Oct', author: 'Me' },
      sections: { summary: 'x', next: ['y'] },
    });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.issues).toEqual([
      {
        path: 'format',
        problem: 'unsupported_format',
        message: 'Template "Weekly" renders to pdf or docx, not "pptx".',
      },
      {
        path: 'cover.author',
        problem: 'unknown_cover_field',
        message: 'This template\'s cover has title, period; remove "author".',
      },
      { path: 'cover.title', problem: 'missing_cover_field', message: 'The cover needs "title".' },
    ]);
  });

  it('accepts a format the template allows, case-insensitively', () => {
    const checked = checkReportContent(template, {
      format: 'DOCX',
      cover: { title: 'W' },
      sections: { summary: 'x', next: ['y'] },
    });
    expect(checked.ok && checked.document.format).toBe('docx');
  });

  it('enforces size limits', () => {
    const checked = checkReportContent(template, {
      cover: { title: 'x'.repeat(REPORT_CONTENT_LIMITS.coverField + 1) },
      sections: {
        summary: 'x'.repeat(REPORT_CONTENT_LIMITS.markdownChars + 1),
        next: Array.from({ length: REPORT_CONTENT_LIMITS.bullets + 1 }, () => 'b'),
      },
    });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.issues.map((i) => [i.path, i.problem])).toEqual([
      ['cover.title', 'too_long'],
      ['sections.summary', 'too_long'],
      ['sections.next', 'too_long'],
    ]);
  });

  it('refuses non-object sections', () => {
    const checked = checkReportContent(template, { cover: { title: 'W' }, sections: ['summary'] });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.issues[0]).toMatchObject({ path: 'sections', problem: 'wrong_shape' });
  });
});
