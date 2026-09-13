import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FileAttachmentCard } from './file-attachment-card';

describe('FileAttachmentCard', () => {
  it('uses the semantic card surface instead of the raised control surface', () => {
    const html = renderToStaticMarkup(createElement(FileAttachmentCard, { name: 'review.html', size: 28_000 }));

    expect(html).toContain('bg-surface-card');
    expect(html).not.toContain('bg-surface-raised');
  });
});
