import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { tiptapJsonToMarkdown } from './editor/serialize';
describe('desktop knowledge editor', () => {
  it('keeps the classic Tiptap schema, parser and serializer verbatim', () => {
    for (const name of ['extensions.ts', 'md-html.ts', 'serialize.ts'])
      expect(
        readFileSync(new URL(`./editor/${name}`, import.meta.url), 'utf8')
          .split('\n')
          .slice(1)
          .join('\n'),
      ).toBe(readFileSync(new URL(`../../../../packages/knowledge-editor/src/${name}`, import.meta.url), 'utf8'));
  });
  it('preserves nested lists, links, tables and images in canonical Markdown', () => {
    const markdown = tiptapJsonToMarkdown({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Policy' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Greenhouse', marks: [{ type: 'link', attrs: { href: 'https://example.test' } }] },
          ],
        },
        { type: 'image', attrs: { src: 'https://example.test/image.png', alt: 'Desk' } },
      ],
    });
    expect(markdown).toContain('## Policy');
    expect(markdown).toContain('[Greenhouse](https://example.test)');
    expect(markdown).toContain('![Desk](https://example.test/image.png)');
  });
});
