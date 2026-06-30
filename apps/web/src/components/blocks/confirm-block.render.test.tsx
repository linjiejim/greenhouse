/**
 * Regression test: confirm-block buttons were inert in chat because the message
 * bubbles never passed `onConfirmAction` to <RichMarkdown>. ConfirmBlock disables
 * its buttons when no handler is wired. These tests pin the behavior at the
 * RichMarkdown seam: a handler → interactive buttons; no handler → disabled.
 */

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RichMarkdown } from '../rich-markdown';

const confirmContent =
  '```confirm\n' +
  JSON.stringify({
    text: 'Proceed with the change?',
    actions: [
      { label: 'Yes, proceed', value: 'yes', variant: 'primary' },
      { label: 'Cancel', value: 'no' },
    ],
  }) +
  '\n```';

describe('confirm block interactivity', () => {
  it('renders enabled buttons when onConfirmAction is wired (chat)', () => {
    const html = renderToStaticMarkup(
      createElement(RichMarkdown, { content: confirmContent, onConfirmAction: () => {} }),
    );
    expect(html).toContain('Yes, proceed');
    expect(html).not.toContain('disabled');
  });

  it('renders disabled buttons when no handler is provided (read-only contexts)', () => {
    const html = renderToStaticMarkup(createElement(RichMarkdown, { content: confirmContent }));
    expect(html).toContain('Yes, proceed');
    expect(html).toContain('disabled');
  });
});
