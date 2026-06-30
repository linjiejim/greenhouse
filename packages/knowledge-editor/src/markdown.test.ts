/**
 * Unit tests for markdownToTiptapJson — the server-side Markdown→Tiptap bridge.
 * Pure (no DB / no browser): verifies the generated JSON matches the editor schema.
 */

import { describe, it, expect } from 'vitest';
import { markdownToTiptapJson, EMPTY_TIPTAP_DOC } from './markdown.js';

function parse(md: string) {
  return JSON.parse(markdownToTiptapJson(md)) as {
    type: string;
    content?: Array<Record<string, any>>;
  };
}

describe('markdownToTiptapJson', () => {
  it('returns {} for empty / blank input', () => {
    expect(markdownToTiptapJson('')).toBe(EMPTY_TIPTAP_DOC);
    expect(markdownToTiptapJson('   \n  ')).toBe(EMPTY_TIPTAP_DOC);
    expect(markdownToTiptapJson(null)).toBe(EMPTY_TIPTAP_DOC);
    expect(markdownToTiptapJson(undefined)).toBe(EMPTY_TIPTAP_DOC);
  });

  it('produces a valid doc node with a content array (what the editor expects)', () => {
    const doc = parse('# Hello\n\nWorld');
    expect(doc.type).toBe('doc');
    expect(Array.isArray(doc.content)).toBe(true);
  });

  it('maps headings to heading nodes with the right level', () => {
    const doc = parse('# H1\n\n## H2\n\n### H3');
    const headings = (doc.content ?? []).filter((n) => n.type === 'heading');
    expect(headings.map((h) => h.attrs?.level)).toEqual([1, 2, 3]);
    expect(headings[0].content?.[0]?.text).toBe('H1');
  });

  it('captures inline marks: bold, italic, inline code', () => {
    const doc = parse('This is **bold**, *italic* and `code`.');
    const para = (doc.content ?? []).find((n) => n.type === 'paragraph');
    const texts = (para?.content ?? []) as Array<{ text: string; marks?: Array<{ type: string }> }>;
    const markTypesFor = (substr: string) => (texts.find((t) => t.text === substr)?.marks ?? []).map((m) => m.type);
    expect(markTypesFor('bold')).toContain('bold');
    expect(markTypesFor('italic')).toContain('italic');
    expect(markTypesFor('code')).toContain('code');
  });

  it('captures link marks with href', () => {
    const doc = parse('See [the docs](https://example.com).');
    const para = (doc.content ?? []).find((n) => n.type === 'paragraph');
    const linked = (para?.content ?? []).find((t: any) => (t.marks ?? []).some((m: any) => m.type === 'link')) as any;
    expect(linked?.text).toBe('the docs');
    const linkMark = linked.marks.find((m: any) => m.type === 'link');
    expect(linkMark.attrs.href).toBe('https://example.com');
  });

  it('maps bullet and ordered lists to list nodes', () => {
    const bullet = parse('- a\n- b');
    expect((bullet.content ?? []).some((n) => n.type === 'bulletList')).toBe(true);

    const ordered = parse('1. first\n2. second');
    expect((ordered.content ?? []).some((n) => n.type === 'orderedList')).toBe(true);
  });

  it('maps fenced code blocks and blockquotes', () => {
    const code = parse('```\nconst x = 1;\n```');
    expect((code.content ?? []).some((n) => n.type === 'codeBlock')).toBe(true);

    const quote = parse('> quoted line');
    expect((quote.content ?? []).some((n) => n.type === 'blockquote')).toBe(true);
  });
});
