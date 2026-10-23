/** @vitest-environment happy-dom */

/**
 * SkillHub › Report templates: the list shows team templates and drafts in
 * the current language, edit/delete only where the server says the member
 * may, and the section editor adds, reorders and checks section keys.
 */

import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReportTemplateSection, ReportTemplateView } from '@greenhouse/types/reports';

function template(id: string, name: string, patch: Partial<ReportTemplateView> = {}): ReportTemplateView {
  return {
    id,
    name,
    description: 'Status every Friday',
    kind: 'report',
    formats: ['pdf', 'docx'],
    sections: [
      { key: 'summary', title: 'Summary', guidance: '', required: true, content: 'markdown' },
      { key: 'next', title: 'Next', guidance: '', required: false, content: 'bullets' },
    ],
    cover_fields: [{ key: 'title', required: true }],
    visibility: 'team',
    owner_user_id: 'u2',
    owner_name: 'Lee',
    version: 1,
    is_default: false,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    can_edit: false,
    ...patch,
  };
}

vi.mock('../../lib/api/report-templates', () => ({
  fetchReportTemplates: vi.fn(async () => [
    template('rtpl_a', 'Weekly report'),
    template('rtpl_b', 'My deck', { kind: 'presentation', formats: ['pptx'], visibility: 'personal', can_edit: true }),
  ]),
  createReportTemplate: vi.fn(),
  updateReportTemplate: vi.fn(),
  deleteReportTemplate: vi.fn(),
  previewReportTemplate: vi.fn(),
}));

import { I18nProvider } from '../../lib/i18n';
import { ReportTemplatesPanel, toInput } from './report-templates';
import { createReportTemplate } from '../../lib/api/report-templates';
import { SectionsField } from '../../components/skillhub/report-template-fields';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(element: React.ReactElement, locale: 'en' | 'zh' = 'en') {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(I18nProvider, { initialLocale: locale, children: element }));
  });
}

async function waitFor(text: string) {
  for (let i = 0; i < 20 && !container?.textContent?.includes(text); i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

describe('ReportTemplatesPanel', () => {
  it('lists templates with kind, formats, section counts and visibility', async () => {
    await mount(createElement(ReportTemplatesPanel), 'zh');
    await waitFor('Weekly report');
    const text = container!.textContent ?? '';
    expect(text).toContain('Weekly report');
    expect(text).toContain('My deck');
    expect(text).toContain('报告');
    expect(text).toContain('演示');
    expect(text).toContain('2 节 · 1 节必填');
    expect(text).toContain('草稿');
    expect(text).toContain('新建模板');
  });

  it('offers edit and delete only on rows the member may change', async () => {
    await mount(createElement(ReportTemplatesPanel));
    await waitFor('My deck');
    const rows = [...container!.querySelectorAll('tr')].filter(
      (row) => row.textContent?.includes('Weekly report') || row.textContent?.includes('My deck'),
    );
    const weekly = rows.find((row) => row.textContent?.includes('Weekly report'))!;
    const mine = rows.find((row) => row.textContent?.includes('My deck'))!;
    expect(weekly.querySelector('[data-testid="report-templates-edit"]')).toBeNull();
    expect(mine.querySelector('[data-testid="report-templates-edit"]')).not.toBeNull();
    expect(mine.querySelector('[data-testid="report-templates-delete"]')).not.toBeNull();
  });
});

describe('output formats', () => {
  it('keeps a cleared selection cleared instead of defaulting it', () => {
    expect(toInput({ name: 'x', kind: 'report', formats: [] }).formats).toEqual([]);
    expect(toInput({ name: 'x', kind: 'presentation', formats: ['docx'] }).formats).toEqual([]);
    expect(toInput({ name: 'x', kind: 'presentation', formats: ['pdf', 'pptx'] }).formats).toEqual(['pptx', 'pdf']);
  });

  it('refuses to save a template with every format unticked, and says why', async () => {
    await mount(createElement(ReportTemplatesPanel));
    await waitFor('Weekly report');
    const add = container!.querySelector('[data-testid="report-templates-new"]') as HTMLButtonElement;
    await act(async () => add.click());
    // A new report template starts with PDF and Word ticked; untick both.
    for (const label of ['PDF', 'Word (.docx)']) {
      const box = [...document.querySelectorAll('label')]
        .find((node) => node.textContent?.trim() === label)!
        .querySelector('input') as HTMLInputElement;
      expect(box.checked).toBe(true);
      await act(async () => box.click());
      expect(box.checked).toBe(false);
    }
    const submit = document.querySelector('[data-testid="report-templates-submit"]') as HTMLButtonElement;
    await act(async () => submit.click());
    expect(document.body.textContent).toContain('Pick at least one output format.');
    expect(createReportTemplate).not.toHaveBeenCalled();
  });
});

describe('SectionsField', () => {
  function Harness({
    initial,
    onChange,
  }: {
    initial: ReportTemplateSection[];
    onChange: (v: ReportTemplateSection[]) => void;
  }) {
    const [value, setValue] = useState(initial);
    return createElement(SectionsField, {
      value,
      onChange: (next: ReportTemplateSection[]) => {
        setValue(next);
        onChange(next);
      },
    });
  }

  it('adds a section with a fresh key, moves it up, and flags a bad or duplicate key', async () => {
    const changes: ReportTemplateSection[][] = [];
    await mount(
      createElement(Harness, {
        initial: [
          { key: 'summary', title: 'Summary', guidance: '', required: true, content: 'markdown' },
          { key: 'Bad Key', title: 'Oops', guidance: '', required: false, content: 'table' },
        ],
        onChange: (v) => changes.push(v),
      }),
    );
    expect(container!.textContent).toContain('Start with a lowercase letter');

    const add = [...container!.querySelectorAll('button')].find((b) => b.textContent?.includes('Add section'))!;
    await act(async () => add.click());
    expect(changes.at(-1)!.map((s) => s.key)).toEqual(['summary', 'Bad Key', 'section_3']);

    const upButtons = container!.querySelectorAll('button[aria-label="Move up"]');
    await act(async () => (upButtons[2] as HTMLButtonElement).click());
    expect(changes.at(-1)!.map((s) => s.key)).toEqual(['summary', 'section_3', 'Bad Key']);

    const keyInputs = container!.querySelectorAll('input[aria-label="key"]');
    const input = keyInputs[1] as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'summary');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container!.textContent).toContain('Another section already uses this key.');
  });
});
