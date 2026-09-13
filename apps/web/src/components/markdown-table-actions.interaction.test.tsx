/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n';
import { Markdown } from './markdown';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mountedRoot: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (mountedRoot) await act(async () => mountedRoot?.unmount());
  container?.remove();
  mountedRoot = null;
  container = null;
});

describe('Markdown table toolbar', () => {
  it('uses icon-only export/fullscreen/copy actions and copies the table as TSV', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    container = document.createElement('div');
    document.body.appendChild(container);
    mountedRoot = createRoot(container);

    await act(async () => {
      mountedRoot?.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(Markdown, {
            compact: true,
            content: '| Name | Count |\n| --- | ---: |\n| Basil | 3 |',
          }),
        }),
      );
    });

    const exportButton = container.querySelector<HTMLButtonElement>('[data-md-table-export]');
    const fullscreen = container.querySelector<HTMLButtonElement>('[data-md-table-fullscreen]');
    const copy = container.querySelector<HTMLButtonElement>('[data-md-table-copy]');
    expect(exportButton?.getAttribute('title')).toBe('Export table as CSV');
    expect(fullscreen?.getAttribute('title')).toBe('View table fullscreen');
    expect(copy?.getAttribute('title')).toBe('Copy table');
    expect(exportButton?.textContent).toBe('');
    expect(fullscreen?.textContent).toBe('');
    expect(copy?.textContent).toBe('');

    await act(async () => copy?.click());
    expect(writeText).toHaveBeenCalledWith('Name\tCount\nBasil\t3');

    await act(async () => fullscreen?.click());
    expect(document.body.textContent).toContain('View table fullscreen');
    expect(document.body.querySelectorAll('table')).toHaveLength(2);
  });
});

describe('Markdown code block toolbar', () => {
  it('limits inline code height and opens a fullscreen code dialog', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    mountedRoot = createRoot(container);

    await act(async () => {
      mountedRoot?.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(Markdown, {
            compact: true,
            content: '```ts\nconst answer = 42;\n```',
          }),
        }),
      );
    });

    const inlinePre = container.querySelector<HTMLPreElement>('.md-code-shell > pre.hl-pre');
    const fullscreen = container.querySelector<HTMLButtonElement>('[data-md-code-fullscreen]');
    expect(inlinePre).not.toBeNull();
    expect(fullscreen?.getAttribute('title')).toBe('View code fullscreen');
    expect(fullscreen?.textContent).toBe('');

    await act(async () => fullscreen?.click());
    expect(document.body.textContent).toContain('View code fullscreen');
    expect(document.body.querySelector('.md-code-fullscreen-view pre.hl-pre')?.textContent).toContain(
      'const answer = 42;',
    );
  });
});
