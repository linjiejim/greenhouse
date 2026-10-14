import { describe, expect, it } from 'vitest';
import { DOC_CONTENT_MAX } from '@greenhouse/contract';
import {
  canonicalFileLinks,
  docLinkIds,
  docSnippet,
  fileLinkIds,
  markdownText,
  mentionIds,
  replaceDocLinks,
  signFileLinks,
  snippetFor,
} from '../markdown.js';

const DOC_A = 'doc_01JAAAAAAAAAAAAAAAAAAAAAAA';
const DOC_B = 'doc_01JBBBBBBBBBBBBBBBBBBBBBBB';
const MEMBER = 'mbr_01JCCCCCCCCCCCCCCCCCCCCCCC';
const FILE = 'fil_01JDDDDDDDDDDDDDDDDDDDDDDD';

describe('links in a doc', () => {
  it('finds doc links once each, wherever they are written, but not in code', () => {
    const md = [
      `See [A](#/knowledge/${DOC_A}) and [again](#/knowledge/${DOC_A}).`,
      `Full address: https://greenhouse.example/#/knowledge/${DOC_B}`,
      '```',
      `[ignored](#/knowledge/doc_01JEEEEEEEEEEEEEEEEEEEEEEE)`,
      '```',
      'Inline `#/knowledge/doc_01JFFFFFFFFFFFFFFFFFFFFFFF` too.',
      `Not an id: #/knowledge/${DOC_A}X`,
    ].join('\n');
    expect(docLinkIds(md)).toEqual([DOC_A, DOC_B]);
  });

  it('finds mentions, also with escaped brackets in the name', () => {
    const md = `Hi [@Ann](member:${MEMBER}), [@Bo \\[ops\\]](member:mbr_01JGGGGGGGGGGGGGGGGGGGGGGG) and [@Ann](member:${MEMBER}).`;
    expect(mentionIds(md)).toEqual([MEMBER, 'mbr_01JGGGGGGGGGGGGGGGGGGGGGGG']);
    expect(mentionIds('`[@Ann](member:mbr_01JCCCCCCCCCCCCCCCCCCCCCCC)` in code')).toEqual([]);
  });

  it('stores file links without signatures and signs them for a reader', () => {
    const signed = `![x](/api/files/${FILE}/content?exp=1&m=${MEMBER}&sig=abc) [y](https://h.example/api/files/${FILE}/content?exp=2&sig=d)`;
    const canonical = canonicalFileLinks(signed);
    expect(canonical).toBe(`![x](/api/files/${FILE}/content) [y](https://h.example/api/files/${FILE}/content)`);
    expect(fileLinkIds(canonical)).toEqual([FILE]);
    expect(signFileLinks(canonical, (id) => `/api/files/${id}/content?sig=me`)).toBe(
      `![x](/api/files/${FILE}/content?sig=me) [y](https://h.example/api/files/${FILE}/content?sig=me)`,
    );
  });

  it('rewrites doc links that have a new target and leaves the rest', () => {
    const md = `[A](#/knowledge/${DOC_A}) [B](#/knowledge/${DOC_B})`;
    expect(replaceDocLinks(md, (id) => (id === DOC_A ? 'a.md' : null))).toBe(`[A](a.md) [B](#/knowledge/${DOC_B})`);
  });
});

describe('plain text', () => {
  it('keeps the words and drops markup, link targets and escapes', () => {
    const md = [
      '# Title',
      '',
      '> **Bold** and *italic* with `code` and a [link](https://example.com).',
      '',
      '- item one',
      '1. first',
      '',
      '| A | B |',
      '| --- | --- |',
      '| x | y |',
      '',
      '![chart](/api/files/x/content)',
      'Escaped \\*star\\* and [see \\[1\\]](https://example.com/notes)',
    ].join('\n');
    const text = markdownText(md);
    expect(text).toContain('Title');
    expect(text).toContain('see [1]');
    expect(text).toContain('Bold and italic with code and a link.');
    expect(text).toContain('item one');
    expect(text).toContain('chart');
    expect(text).toContain('Escaped star');
    expect(text).not.toMatch(/https:|\*\*|---|\]\(/);
  });

  it('cuts a snippet around the first matching word', () => {
    const text = `${'前言。'.repeat(60)}设备水位低时会触发报警，请检查水箱。${'结尾。'.repeat(60)}`;
    const snippet = snippetFor(text, ['报警', '水位'], 40);
    expect(snippet).toContain('水位');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippetFor('short text', ['missing'])).toBe('short text');
    expect(snippetFor('x'.repeat(300), ['missing'], 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('reads only the Markdown around the match for a doc snippet', () => {
    const doc = `${'Intro **bold**. '.repeat(500)}The [pump](#/knowledge/${DOC_A}) alarm.${' Tail.'.repeat(500)}`;
    const snippet = docSnippet(doc, ['alarm'], 40);
    expect(snippet).toContain('pump alarm.');
    expect(snippet).not.toMatch(/\*\*|\]\(/);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(docSnippet('# Short\n\nNothing here.', ['missing'])).toBe('Short Nothing here.');
  });
});

describe('hostile input', () => {
  // Everything here runs on saves, comments and search hits, on text anyone may write: a doc
  // as long as it may be must never cost more than a moment.
  const longest = DOC_CONTENT_MAX;
  const fill = (unit: string, tail = '') => unit.repeat(Math.floor((longest - tail.length) / unit.length)) + tail;
  const cases: Record<string, string> = {
    'a rule line that ends in a letter': fill('-|:', 'x'),
    'rule lines that never end': fill(`${'-'.repeat(200)} |\n`),
    'opening brackets': fill('['),
    'images that never close': fill('!['),
    'link targets that never close': fill('[a]('),
    'escaped brackets': fill('[\\['),
    'angle brackets': fill('<'),
    'tags that never close': fill('<a '),
    'wide spaces without a newline': fill('　 \t', 'x'),
    'spaces around newlines': fill(' \n　'),
    'digits without a list mark': fill('1'),
    'mentions that never close': fill('[@'),
    'escapes in mentions': fill('[@\\]'),
    fences: fill('```\n~~~\n'),
    backticks: fill('`'),
    'doc links that never finish': fill('#/knowledge/doc_'),
    'link targets before a doc link': fill('](x'),
    'file links that never finish': fill('/api/files/fil_'),
  };
  it.each(Object.entries(cases))('stays fast on %s', (_name, text) => {
    expect(text.length).toBeGreaterThan(longest - 1_000);
    const started = performance.now();
    markdownText(text);
    mentionIds(text);
    docLinkIds(text);
    fileLinkIds(text);
    canonicalFileLinks(text);
    replaceDocLinks(text, () => 'x.md');
    docSnippet(text, ['missing']);
    snippetFor(text, ['missing']);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});
