import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArtifactCard } from './artifact-card';

describe('ArtifactCard surface semantics', () => {
  it('keeps content on canvas and structural chrome on the muted surface', () => {
    const html = renderToStaticMarkup(
      <ArtifactCard icon={<span>i</span>} title="Draft" footer={<button>Confirm</button>}>
        <p>Review this content</p>
      </ArtifactCard>,
    );

    expect(html).toContain('bg-surface-canvas');
    expect(html.match(/bg-surface-muted/g)).toHaveLength(2);
    expect(html).not.toContain('bg-surface-sunken');
    expect(html).not.toContain('bg-surface-raised');
  });

  it('keeps a collapsed header on the same muted chrome surface', () => {
    const html = renderToStaticMarkup(
      <ArtifactCard icon={<span>i</span>} title="Completed" collapsed onToggle={() => undefined}>
        <p>Hidden receipt</p>
      </ArtifactCard>,
    );

    expect(html).toContain('bg-surface-muted');
    expect(html).not.toContain('Hidden receipt');
  });
});
