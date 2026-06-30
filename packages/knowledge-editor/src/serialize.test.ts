/**
 * Round-trip tests: Markdown → Tiptap JSON (markdown.ts) → Markdown (serialize.ts).
 *
 * These encode audit 2026-06-10 defect #5: agent-written tables/images were
 * silently dropped by a human edit-save, and aggressive escaping corrupted
 * plain prose ("GH-Max" → "GH\-Max").
 */

import { describe, it, expect } from 'vitest';
import { markdownToTiptapJson } from './markdown.js';
import { tiptapJsonToMarkdown, type TiptapNode } from './serialize.js';

function roundTrip(md: string): string {
  const json = JSON.parse(markdownToTiptapJson(md)) as TiptapNode;
  return tiptapJsonToMarkdown(json);
}

describe('escaping (the GH\\-Max bug)', () => {
  it('leaves product codes, versions and ordinary punctuation untouched', () => {
    expect(roundTrip('GH-Max supports 21 pods.')).toBe('GH-Max supports 21 pods.');
    expect(roundTrip('Released v1.0 (2026) — 50% faster!')).toBe('Released v1.0 (2026) — 50% faster!');
    expect(roundTrip('Use pH 5.5-6.5 for basil.')).toBe('Use pH 5.5-6.5 for basil.');
  });

  it('still escapes genuine inline markdown triggers', () => {
    const out = roundTrip(String.raw`a \*literal\* star`);
    expect(out).toBe(String.raw`a \*literal\* star`);
  });

  it('escapes block triggers only at line starts', () => {
    // A paragraph that LOOKS like a list/heading must not become one.
    const json: TiptapNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '- not a list' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '# not a heading' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '1. not ordered' }] },
      ],
    };
    const out = tiptapJsonToMarkdown(json);
    expect(out).toContain('\\- not a list');
    expect(out).toContain('\\# not a heading');
    expect(out).toContain('1\\. not ordered');
    // …and re-parsing keeps them as paragraphs, not lists/headings.
    const reparsed = JSON.parse(markdownToTiptapJson(out)) as TiptapNode;
    expect((reparsed.content ?? []).map((n) => n.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
  });
});

describe('tables survive the round-trip (previously silently dropped)', () => {
  const table = ['| Model | Pods |', '| --- | --- |', '| GH-Max | 21 |', '| GH-SE | 12 |'].join('\n');

  it('markdown table → JSON contains a table node', () => {
    const json = JSON.parse(markdownToTiptapJson(table)) as TiptapNode;
    const types = (json.content ?? []).map((n) => n.type);
    expect(types).toContain('table');
  });

  it('JSON → markdown reproduces a GFM table with intact cells', () => {
    const out = roundTrip(table);
    expect(out).toContain('| Model | Pods |');
    expect(out).toContain('| --- | --- |');
    expect(out).toContain('| GH-Max | 21 |');
    expect(out).toContain('| GH-SE | 12 |');
  });

  it('double round-trip is stable', () => {
    expect(roundTrip(roundTrip(table))).toBe(roundTrip(table));
  });

  it('escapes pipes inside cells', () => {
    const json: TiptapNode = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a|b' }] }] },
              ],
            },
          ],
        },
      ],
    };
    expect(tiptapJsonToMarkdown(json)).toContain('a\\|b');
  });
});

describe('images survive the round-trip (previously silently dropped)', () => {
  it('keeps src and alt', () => {
    const md = '![pump diagram](https://cdn.example.com/pump.png)';
    const json = JSON.parse(markdownToTiptapJson(md)) as TiptapNode;
    expect(JSON.stringify(json)).toContain('pump.png');
    const out = roundTrip(md);
    expect(out).toBe('![pump diagram](https://cdn.example.com/pump.png)');
  });
});

describe('existing constructs still round-trip', () => {
  it('headings, lists, quotes, code and links', () => {
    const md = [
      '# Title',
      '',
      'Some **bold** and *italic* and `code` and [link](https://example.com).',
      '',
      '- one',
      '- two',
      '',
      '1. first',
      '2. second',
      '',
      '> quoted',
      '',
      '```js',
      'const x = 1; // no \\ escaping in here',
      '```',
    ].join('\n');
    const out = roundTrip(md);
    expect(out).toContain('# Title');
    expect(out).toContain('**bold**');
    expect(out).toContain('*italic*');
    expect(out).toContain('`code`');
    expect(out).toContain('[link](https://example.com)');
    expect(out).toContain('- one');
    expect(out).toContain('1. first');
    expect(out).toContain('> quoted');
    expect(out).toContain('const x = 1; // no \\ escaping in here');
    // Stability: a second pass changes nothing.
    expect(roundTrip(out)).toBe(out);
  });
});
