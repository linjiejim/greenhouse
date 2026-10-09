/**
 * @vitest-environment happy-dom
 *
 * An unclosed block in the extension: a placeholder while the answer streams,
 * ordinary code once the message has settled — nothing will ever close it, so
 * a placeholder there would spin forever. Needs a real DOM: the settled path
 * renders through <Markdown>'s sanitizer.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichMarkdown } from './rich-markdown';

const CUT_OFF = 'Before\n\n```chart\n{"type":"bar","labels":["a"';

describe('<RichMarkdown/> unclosed blocks', () => {
  it('holds a streaming block behind a placeholder', () => {
    const html = renderToStaticMarkup(
      createElement(RichMarkdown, { content: CUT_OFF, compact: true, streaming: true }),
    );

    expect(html).toContain('role="status"');
    expect(html).not.toContain('<code');
  });

  it('shows a settled message that ends mid-block as a code block', () => {
    const html = renderToStaticMarkup(createElement(RichMarkdown, { content: CUT_OFF, compact: true }));

    expect(html).toContain('Before');
    expect(html).toContain('<code');
    expect(html).not.toContain('role="status"');
  });
});
