/**
 * @vitest-environment happy-dom
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n';
import { useSidePaneStore } from '../stores/side-pane-store';
import { MediaPreviewDialog } from './media-preview-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('MediaPreviewDialog mobile containment', () => {
  beforeEach(() => {
    useSidePaneStore.setState({ stack: [], isOpen: false, hostMounted: false });
  });

  it('provides a visible close action and touch-sized media controls', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(MediaPreviewDialog, {
          open: true,
          files: [{ src: '/example.png', type: 'image', name: 'Example' }],
          onClose: vi.fn(),
        }),
      }),
    );

    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('aria-label="Previous"');
    expect(html).toContain('aria-label="Next"');
    expect(html).toContain('aria-label="Download"');
    expect(html).toContain('h-11');
    expect(html).toContain('mobile-visual-viewport');
  });

  it('offers image markup for authenticated chat images when the Chat pane exists', async () => {
    useSidePaneStore.setState({ hostMounted: true });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(MediaPreviewDialog, {
            open: true,
            files: [{ src: '/api/upload/generated.png', type: 'image' }],
            onClose: vi.fn(),
          }),
        }),
      );
    });

    expect(container.innerHTML).toContain('aria-label="Mark up"');
    await act(async () => root.unmount());
  });
});
