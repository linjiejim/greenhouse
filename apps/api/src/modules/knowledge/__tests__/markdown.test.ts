import { describe, expect, it } from 'vitest';
import { DOC_CONTENT_MAX } from '@greenhouse/contract';
import {
  docLinkIds,
  docSnippet,
  fileLinks,
  markdownText,
  mentionIds,
  replaceDocLinks,
  snippetFor,
} from '../markdown.js';

const DOC_A = 'doc_01JAAAAAAAAAAAAAAAAAAAAAAA';
const DOC_B = 'doc_01JBBBBBBBBBBBBBBBBBBBBBBB';
const MEMBER = 'mbr_01JCCCCCCCCCCCCCCCCCCCCCCC';
const FILE = 'fil_01JDDDDDDDDDDDDDDDDDDDDDDD';
const OTHER = 'fil_01JEEEEEEEEEEEEEEEEEEEEEEE';
const links = fileLinks('https://greenhouse.example/');
const sign = (id: string) => `/api/files/${id}/content?sig=me`;

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

  it('stores file links without signatures and signs them for a reader, on this server only', () => {
    const signed = [
      `![x](/api/files/${FILE}/content?exp=1&m=${MEMBER}&sig=abc)`,
      `[y](HTTPS://Greenhouse.Example:443/api/files/${FILE}/content?exp=2&sig=d)`,
      `[z](https://outside.example/api/files/${OTHER}/content?exp=2&sig=d)`,
    ].join(' ');
    const canonical = links.canonical(signed);
    expect(canonical).toBe(
      [
        `![x](/api/files/${FILE}/content)`,
        `[y](HTTPS://Greenhouse.Example:443/api/files/${FILE}/content)`,
        // Another host's address is not ours to touch.
        `[z](https://outside.example/api/files/${OTHER}/content?exp=2&sig=d)`,
      ].join(' '),
    );
    expect(links.ids(canonical)).toEqual([FILE]);
    expect(links.sign(canonical, sign)).toBe(
      [
        `![x](/api/files/${FILE}/content?sig=me)`,
        `[y](HTTPS://Greenhouse.Example:443/api/files/${FILE}/content?sig=me)`,
        `[z](https://outside.example/api/files/${OTHER}/content?exp=2&sig=d)`,
      ].join(' '),
    );
  });

  it('never signs a file link that another address, raw HTML or an autolink could hold', () => {
    const file = (letter: string) => `fil_01J${letter.repeat(23)}`;
    const hostile = [
      // The same path on another host, or after a path, a query or a parenthesis of one.
      `![a](https://outside.example/api/files/${file('A')}/content)`,
      `![b](https://outside.example/x/api/files/${file('B')}/content)`,
      `![c](https://outside.example/?u=/api/files/${file('C')}/content)`,
      `![d](https://outside.example/(/api/files/${file('D')}/content))`,
      `![e](https://outside.example/](/api/files/${file('E')}/content))`,
      `![f](//outside.example/![x](/api/files/${file('F')}/content))`,
      // Inside an angle-bracket target, which may hold spaces, or an escaped `>`.
      `[g](<https://outside.example/ ![x](/api/files/${file('G')}/content)>)`,
      `[h](< https://outside.example/\\> ![x](/api/files/${file('H')}/content)>)`,
      // Inside raw HTML: an attribute, across lines, or a value no closing quote ends.
      `<img src="/api/files/${file('J')}/content">`,
      `<img\nsrc='https://outside.example/?x= ![y](/api/files/${file('K')}/content)'>`,
      `<div><img src='https://outside.example/\n\n![y](/api/files/${file('M')}/content)\n\n<p title='x'>`,
      `<style>p { background: url('https://outside.example/ ![y](/api/files/${file('N')}/content)') }</style>`,
      // Inside an address the parser links as a whole, or a reference definition's target.
      `https://outside.example/![z](/api/files/${file('P')}/content)`,
      `www.outside.example/![z](/api/files/${file('Q')}/content)`,
      `[r]:\n//outside.example/![z](/api/files/${file('R')}/content)`,
      // Not a link at all.
      `see /api/files/${file('S')}/content`,
    ].join('\n\n');
    expect(links.sign(hostile, sign)).toBe(hostile);
    // A page base would send every relative address elsewhere: nothing is signed.
    const based = `<base href="https://outside.example/">\n\n![ok](/api/files/${FILE}/content)`;
    expect(links.sign(based, sign)).toBe(based);
  });

  it('signs the links and pictures the editor writes, in prose of any language', () => {
    const md = [
      `![a](/api/files/${FILE}/content "title")`,
      `见[文档](/api/files/${FILE}/content)和[表格](https://greenhouse.example/api/files/${OTHER}/content)。`,
      `- ![list item](/api/files/${FILE}/content)`,
      `> ![quote](/api/files/${FILE}/content)`,
      `| ![cell](/api/files/${FILE}/content) | [a \\[1\\]](/api/files/${OTHER}/content) |`,
      `<b>bold</b> ![after a tag](/api/files/${FILE}/content)`,
      `See https://outside.example/page then ![after an address](/api/files/${FILE}/content)`,
    ].join('\n');
    expect(links.sign(md, sign).match(/sig=me/g)).toHaveLength(9);
    // Forms the editor never writes stay unsigned: no picture is worth a doubt.
    const other = [
      `[b](</api/files/${FILE}/content>)`,
      `<https://greenhouse.example/api/files/${FILE}/content>`,
      `![c][pic]`,
      '',
      `[pic]: /api/files/${OTHER}/content`,
    ].join('\n');
    expect(links.sign(other, sign)).toBe(other);
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
    'file links everywhere': fill(
      `![x](/api/files/${FILE}/content) [y](https://greenhouse.example/api/files/${OTHER}/content)\n`,
    ),
  };
  // Linear work takes milliseconds here; the old patterns took minutes. The budget leaves room
  // for a busy machine without letting anything super-linear through.
  it.each(Object.entries(cases))('stays fast on %s', { timeout: 30_000 }, (_name, text) => {
    expect(text.length).toBeGreaterThan(longest - 1_000);
    const started = performance.now();
    markdownText(text);
    mentionIds(text);
    docLinkIds(text);
    links.ids(text);
    links.canonical(text);
    links.sign(text, sign);
    replaceDocLinks(text, () => 'x.md');
    docSnippet(text, ['missing']);
    snippetFor(text, ['missing']);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
