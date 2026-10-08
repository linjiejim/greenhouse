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

  it.each([
    ['chart', '{"type":"bar","labels":["a"'],
    ['mermaid', 'flowchart LR\n  A --> '],
    ['html-preview', '<!doctype html><html><body><script>alert(1)'],
  ])('holds a %s fence behind a placeholder until it closes', (fence, partial) => {
    const html = renderToStaticMarkup(
      createElement(RichMarkdown, { content: `\`\`\`${fence}\n${partial}`, compact: true }),
    );

    expect(html).toContain('role="status"');
    expect(html).not.toContain('<code');
    expect(html).not.toContain('alert(1)');
  });
});
