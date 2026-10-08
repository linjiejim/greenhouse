import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichBlockShell } from './rich-block-shell';

describe('RichBlockShell', () => {
  it('uses the semantic card surface for its default tone', () => {
    const html = renderToStaticMarkup(createElement(RichBlockShell, null, 'Content'));

    expect(html).toContain('bg-surface-card');
    expect(html).not.toContain('bg-surface-raised');
  });
});
