/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { MessageActions } from './message-actions';

vi.mock('../pdf-export', () => ({
  ExportPdfButton: () => createElement('button', { 'aria-label': 'Export PDF' }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mountedRoot: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  if (!mountedRoot) return;
  await act(async () => mountedRoot?.unmount());
  mountedRoot = null;
});

describe('MessageActions compact overflow menu', () => {
  it('keeps secondary reply actions behind an upward More menu and opens it on hover', async () => {
    const container = document.createElement('div');
    mountedRoot = createRoot(container);
    await act(async () => {
      mountedRoot?.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(MessageActions, {
            content: 'Answer',
            onFullscreen: vi.fn(),
            onFork: vi.fn(),
            onTranslate: vi.fn(),
            onRegenerate: vi.fn(),
          }),
        }),
      );
    });

    expect(container.querySelector('[role="menu"]')).toBeNull();
    const more = container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
    expect(more).not.toBeNull();

    await act(async () => {
      more?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const menu = container.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('Fullscreen');
    expect(menu?.textContent).toContain('Fork conversation');
    expect(menu?.textContent).toContain('Translate to English');
    expect(menu?.textContent).toContain('Translate to Chinese');
    expect(menu?.className).toContain('bottom-full');
    expect(menu?.className).toContain('pb-1');
  });
});
