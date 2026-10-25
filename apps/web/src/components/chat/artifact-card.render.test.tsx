import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArtifactCard } from './artifact-card';

describe('ArtifactCard surface semantics', () => {
  it('is one card surface: no muted header or footer band, no inner surface', () => {
    const html = renderToStaticMarkup(
      <ArtifactCard icon={<span>i</span>} title="Draft" footer={<button>Confirm</button>}>
        <p>Review this content</p>
      </ArtifactCard>,
    );

    expect(html).toContain('bg-surface-card');
    expect(html).toContain('rounded-lg');
    expect(html).not.toContain('bg-surface-muted');
    expect(html).not.toContain('bg-surface-sunken');
    expect(html).not.toContain('bg-surface-raised');
  });

  it('keeps a collapsed header a quiet toggle on the card surface', () => {
    const html = renderToStaticMarkup(
      <ArtifactCard icon={<span>i</span>} title="Completed" collapsed onToggle={() => undefined}>
        <p>Hidden receipt</p>
      </ArtifactCard>,
    );

    expect(html).toContain('hover:bg-surface-muted');
    expect(html).not.toContain('Hidden receipt');
  });
});
