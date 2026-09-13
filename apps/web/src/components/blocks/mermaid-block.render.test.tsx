/**
 * @vitest-environment happy-dom
 *
 * RichMarkdown's sanitizer needs a DOMParser; the mermaid module itself is
 * never loaded here (the lazy import only fires in an effect, which server
 * rendering skips) — that is exactly the pre-resolve state being asserted.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MermaidBlock } from './mermaid-block';
import { RichMarkdown } from '../rich-markdown';

const DIAGRAM = 'flowchart LR\n  A[下单] --> B[出库]';

describe('MermaidBlock', () => {
  it('renders a placeholder before the lazy mermaid module resolves', () => {
    // Server render never runs the effect, which is exactly the first paint the
    // browser sees too: a skeleton, never a flash of raw diagram source.
    const html = renderToStaticMarkup(<MermaidBlock code={DIAGRAM} compact />);

    expect(html).toContain('animate-skeleton');
    expect(html).not.toContain('flowchart LR');
  });

  it('is reached through RichMarkdown for a closed mermaid fence', () => {
    const html = renderToStaticMarkup(<RichMarkdown compact content={'Flow:\n\n```mermaid\n' + DIAGRAM + '\n```'} />);

    expect(html).toContain('animate-skeleton');
    expect(html).toContain('Flow:');
  });

  it('leaves an unclosed fence as a plain code block, not a diagram card', () => {
    const html = renderToStaticMarkup(<RichMarkdown compact content={'```mermaid\nflowchart LR\n  A --> '} />);

    expect(html).not.toContain('animate-skeleton');
    expect(html).toContain('flowchart LR');
  });
});
