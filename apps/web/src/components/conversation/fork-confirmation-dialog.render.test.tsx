import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { ForkConfirmationDialog } from './fork-confirmation-dialog';

function renderDialog(fromReply: boolean) {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: 'en',
      children: createElement(ForkConfirmationDialog, {
        open: true,
        fromReply,
        onClose: vi.fn(),
        onConfirm: vi.fn(),
      }),
    }),
  );
}

describe('ForkConfirmationDialog', () => {
  it('explains that a full fork creates an independent copy', () => {
    const html = renderDialog(false);

    expect(html).toContain('Fork this conversation?');
    expect(html).toContain('The shared original stays unchanged');
    expect(html).toContain('Create Fork');
  });

  it('explains the reply boundary for a message fork', () => {
    const html = renderDialog(true);

    expect(html).toContain('Messages after this reply will not be included');
    expect(html).toContain('The original conversation stays unchanged');
  });
});
