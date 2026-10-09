/**
 * @vitest-environment happy-dom
 *
 * Unclosed blocks: a placeholder while streaming, ordinary code once settled.
 * Needs a real DOM: the settled path renders through <Markdown>'s sanitizer.
 */

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
        streaming: true,
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
      createElement(RichMarkdown, { content: `\`\`\`${fence}\n${partial}`, compact: true, streaming: true }),
    );

    expect(html).toContain('role="status"');
    expect(html).not.toContain('<code');
    expect(html).not.toContain('alert(1)');
  });

  // A settled message can still end mid-block (cut off on a path that does not
  // trim, or saved before trimming covered every block). Nothing will close it,
  // so a placeholder would spin forever: show the fence as ordinary code.
  it.each([
    ['datatable', '{"columns":[{"key":"name"'],
    ['chart', '{"type":"bar","labels":["a"'],
    ['mermaid', 'flowchart LR\n  A --> '],
    ['html-preview', '<!doctype html><html><body><script>alert(1)'],
  ])('shows a settled message that ends inside a %s fence as a code block', (fence, partial) => {
    const html = renderToStaticMarkup(
      createElement(RichMarkdown, { content: `Before\n\n\`\`\`${fence}\n${partial}`, compact: true }),
    );

    expect(html).toContain('Before');
    expect(html).toContain('<code');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('animate-skeleton');
    expect(html).not.toContain('<script>');
  });
});
