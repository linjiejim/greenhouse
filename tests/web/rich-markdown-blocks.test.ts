/**
 * Tests for RichMarkdown custom block parsing.
 */

import { describe, expect, it } from 'vitest';
import { parseSegments } from '../../apps/web/src/components/blocks/index';

describe('parseSegments local file previews', () => {
  it('converts html-preview src with a local path into a local-files segment', () => {
    const input = `PPT 已生成：

\`\`\`html-preview
{ "src": "/Users/jim/code/OpenGreensy/slides.html", "title": "OpenGreensy" }
\`\`\``;

    const segments = parseSegments(input);

    expect(segments).toHaveLength(2);
    expect(segments[0].type).toBe('markdown');
    expect(segments[1]).toEqual({
      type: 'local-files',
      data: {
        title: 'OpenGreensy',
        files: [
          {
            path: '/Users/jim/code/OpenGreensy/slides.html',
            label: 'OpenGreensy',
            kind: 'html',
            sourceBlock: 'html-preview',
          },
        ],
      },
    });
  });

  it('extracts multiple local paths from preview items', () => {
    const input = `\`\`\`pdf-preview
{
  "title": "Reports",
  "items": [
    { "src": "/Users/jim/report-q1.pdf", "label": "Q1" },
    { "src": "/Users/jim/report-q2.pdf", "label": "Q2" }
  ]
}
\`\`\``;

    const [segment] = parseSegments(input);

    expect(segment.type).toBe('local-files');
    if (segment.type !== 'local-files') throw new Error('Expected local-files segment');
    expect(segment.data.files.map((file) => file.path)).toEqual([
      '/Users/jim/report-q1.pdf',
      '/Users/jim/report-q2.pdf',
    ]);
    expect(segment.data.files.every((file) => file.kind === 'pdf')).toBe(true);
  });

  it('leaves non-local preview blocks as markdown', () => {
    const input = `\`\`\`html-preview
{ "src": "https://example.com/index.html", "title": "Remote" }
\`\`\``;

    const [segment] = parseSegments(input);

    expect(segment.type).toBe('markdown');
    if (segment.type !== 'markdown') throw new Error('Expected markdown segment');
    expect(segment.content).toContain('html-preview');
    expect(segment.content).toContain('https://example.com/index.html');
  });
});
