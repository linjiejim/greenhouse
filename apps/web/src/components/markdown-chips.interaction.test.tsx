/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n';
import { _resetObjectRefCache } from '../lib/object-refs';
import { Markdown } from './markdown';
import { sanitizeExportHtml } from './markdown';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mountedRoot: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
const fetchMock = vi.fn();

beforeEach(() => {
  _resetObjectRefCache();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  if (mountedRoot) await act(async () => mountedRoot?.unmount());
  container?.remove();
  mountedRoot = null;
  container = null;
  vi.unstubAllGlobals();
});

async function render(content: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  mountedRoot = createRoot(container);
  await act(async () => {
    mountedRoot?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(Markdown, { compact: true, content }),
      }),
    );
  });
  // Let the batched resolve request settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  return container;
}

function chip(root: HTMLElement, href: string): HTMLAnchorElement {
  const a = Array.from(root.querySelectorAll<HTMLAnchorElement>('a.md-chip')).find(
    (el) => el.getAttribute('href') === href,
  );
  if (!a) throw new Error(`no chip for ${href}`);
  return a;
}

const slotText = (a: HTMLElement) => a.querySelector('.md-chip-slot')?.textContent ?? '';

describe('Markdown link chips', () => {
  it('resolves object links in one batch and hides titles the member may not read', async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const { urls } = JSON.parse(String(init.body)) as { urls: string[] };
      expect(urls).toEqual(['#/knowledge/doc/12-plan', '#/projects/9', '#/files?file=7']);
      return new Response(
        JSON.stringify({
          items: [
            { url: '#/knowledge/doc/12-plan', type: 'doc', id: '12', title: 'Q3 plan' },
            { url: '#/projects/9', type: 'project', id: '9', title: null },
            {
              url: '#/files?file=7',
              type: 'file',
              id: '7',
              title: 'quarterly-operations-review-final-version-2026.pdf',
              meta: { size: 2048, contentType: 'application/pdf' },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const root = await render(
      'See [the plan](#/knowledge/doc/12-plan), [secret project](#/projects/9), [report](#/files?file=7) and again [plan](#/knowledge/doc/12-plan).',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slotText(chip(root, '#/knowledge/doc/12-plan'))).toBe('Q3 plan');
    // No permission: the type only — not the text the author wrote.
    const hidden = chip(root, '#/projects/9');
    expect(slotText(hidden)).toBe('Project');
    expect(slotText(hidden)).not.toContain('secret');
    // A file object: name cut in the middle keeping the extension, plus its size.
    const file = slotText(chip(root, '#/files?file=7'));
    expect(file).toMatch(/^quarterly.*….*\.pdf2 KB$/);
    // Entity links keep the peek hooks.
    expect(chip(root, '#/knowledge/doc/12-plan').getAttribute('data-entity-kind')).toBe('kb_doc');
  });

  it('shows external links as domain chips and collapses bare URLs', async () => {
    const root = await render(
      'Read [the release notes](https://www.example.com/blog/2026/release) or https://github.com/linjiejim/greenhouse/pull/12345/files?diff=split',
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const named = chip(root, 'https://www.example.com/blog/2026/release');
    expect(named.getAttribute('data-chip')).toBe('external');
    expect(named.querySelector('.md-chip-host')?.textContent).toBe('example.com');
    expect(named.querySelector('.md-chip-label')?.textContent).toBe('the release notes');
    expect(named.getAttribute('target')).toBe('_blank');

    const bare = chip(root, 'https://github.com/linjiejim/greenhouse/pull/12345/files?diff=split');
    const label = bare.querySelector('.md-chip-label')?.textContent ?? '';
    expect(label.startsWith('github.com/')).toBe(true);
    expect(label).toContain('…');
    expect(Array.from(label).length).toBeLessThanOrEqual(48);
    expect(bare.getAttribute('title')).toBe('https://github.com/linjiejim/greenhouse/pull/12345/files?diff=split');
  });

  it('draws download links as file chips', async () => {
    const root = await render('[export.csv](https://cdn.example.com/x/download?id=1)');
    const file = chip(root, 'https://cdn.example.com/x/download?id=1');
    expect(file.getAttribute('data-chip')).toBe('file');
    expect(slotText(file)).toBe('export.csv');
  });

  it('keeps exports free of chips', () => {
    const html = sanitizeExportHtml('<p><a href="https://example.com/a">x</a></p>');
    expect(html).not.toContain('md-chip');
  });
});
