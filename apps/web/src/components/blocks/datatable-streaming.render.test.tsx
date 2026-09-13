import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichMarkdown } from '../rich-markdown.js';

describe('streaming datatable rendering', () => {
  it('renders a stable placeholder without exposing partial JSON', () => {
    const html = renderToStaticMarkup(
      createElement(RichMarkdown, {
        content: '```datatable\n{"columns":[{"key":"name"',
        compact: true,
      }),
    );

    expect(html).toContain('animate-skeleton');
    expect(html).toContain('data-rich-block-density="compact"');
    expect(html).not.toContain('&quot;columns&quot;');
    expect(html).not.toContain('<code');
  });
});
