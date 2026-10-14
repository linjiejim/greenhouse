/**
 * Round-trip tests: Markdown → Tiptap JSON (markdown.ts) → Markdown (serialize.ts).
 *
 * These encode audit 2026-06-10 defect #5: agent-written tables/images were
 * silently dropped by a human edit-save, and aggressive escaping corrupted
 * plain prose ("LPH-Max" → "LPH\-Max").
 */

import { describe, it, expect } from 'vitest';
import { markdownToTiptapJson } from './markdown.js';
import { markdownToEditorHtml } from './md-html.js';
import { tiptapJsonToMarkdown, type TiptapNode } from './serialize.js';

function roundTrip(md: string): string {
  const json = JSON.parse(markdownToTiptapJson(md)) as TiptapNode;
  return tiptapJsonToMarkdown(json);
}

describe('escaping (the LPH\\-Max bug)', () => {
  it('leaves product codes, versions and ordinary punctuation untouched', () => {
    expect(roundTrip('LPH-Max supports 21 pods.')).toBe('LPH-Max supports 21 pods.');
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
  const table = ['| Model | Pods |', '| --- | --- |', '| LPH-Max | 21 |', '| LPH-SE | 12 |'].join('\n');

  it('markdown table → JSON contains a table node', () => {
    const json = JSON.parse(markdownToTiptapJson(table)) as TiptapNode;
    const types = (json.content ?? []).map((n) => n.type);
    expect(types).toContain('table');
  });

  it('JSON → markdown reproduces a GFM table with intact cells', () => {
    const out = roundTrip(table);
    expect(out).toContain('| Model | Pods |');
    expect(out).toContain('| --- | --- |');
    expect(out).toContain('| LPH-Max | 21 |');
    expect(out).toContain('| LPH-SE | 12 |');
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

describe('the editor loading a doc from its Markdown', () => {
  // Docs store only Markdown, so the editor always loads them by parsing it. That used to be
  // a line-based converter that knew only headings/lists/quotes: a brand doc
  // opened as literal text and the first save wrote the flattening back over the
  // canonical Markdown, escaped. Same source, same schema, same result as the
  // JSON path is what keeps a plain open-and-save from destroying a doc.
  const doc = [
    '# 色彩 Color',
    '',
    '原则是**在大量留白上克制地用绿**，`ink` 承担文字。',
    '',
    '![品牌色板](/api/upload/1753300000000-d8a85e6d.png)',
    '',
    '## 色板',
    '',
    '| Token | Hex |',
    '| --- | --- |',
    '| `green` | `#2E8B3D` |',
    '',
    '#### 细则',
    '',
    'See [the guide](https://example.com).',
  ].join('\n');

  it('matches the JSON path the server would have derived', () => {
    expect(markdownToEditorHtml(doc)).toBe(markdownToEditorHtml(roundTrip(doc)));
  });

  it('keeps bold, inline code, images, tables and h4 instead of flattening them', () => {
    const out = roundTrip(doc);
    expect(out).toContain('**在大量留白上克制地用绿**');
    expect(out).toContain('`ink`');
    expect(out).toContain('![品牌色板](/api/upload/1753300000000-d8a85e6d.png)');
    expect(out).toContain('| Token | Hex |');
    expect(out).toContain('#### 细则');
    expect(out).toContain('[the guide](https://example.com)');
    // The corruption signature: markdown triggers escaped into literal text.
    expect(out).not.toContain('\\*');
    expect(out).not.toContain('\\`');
    expect(out).not.toContain('\\[');
  });

  it('does not turn soft line wraps into hard breaks', () => {
    // apps/web sets marked's global `breaks: true` for chat; inheriting it here
    // would insert a <br> per wrapped line every time a doc round-tripped.
    expect(markdownToEditorHtml('one\ntwo')).not.toContain('<br');
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

describe('knowledge base constructs round-trip (M2.1: Markdown stays the source of truth)', () => {
  const member = 'mbr_01JABCDEFGHJKMNPQRSTVWXYZ0';
  const doc = 'doc_01JABCDEFGHJKMNPQRSTVWXYZ0';
  const file = 'fil_01JABCDEFGHJKMNPQRSTVWXYZ0';

  it('keeps a mention as a mention node and writes it back as a member link', () => {
    const md = `Ask [@Ann Lee](member:${member}) about it.`;
    const json = JSON.parse(markdownToTiptapJson(md)) as TiptapNode;
    const paragraph = json.content?.[0];
    expect(paragraph?.content?.find((node) => node.type === 'mention')?.attrs).toMatchObject({
      id: member,
      label: 'Ann Lee',
    });
    expect(roundTrip(md)).toBe(md);
  });

  it('keeps brackets inside a mention name', () => {
    const md = `Hi [@Ann \\[ops\\]](member:${member})`;
    expect(roundTrip(md)).toBe(md);
    expect(roundTrip(roundTrip(md))).toBe(md);
  });

  it('keeps a doc reference (what `[[` inserts) as a link to the doc', () => {
    const md = `See [Onboarding](#/knowledge/${doc}) first.`;
    expect(roundTrip(md)).toBe(md);
  });

  it('keeps pictures of the file service, signed or not', () => {
    const plain = `![chart](/api/files/${file}/content)`;
    expect(roundTrip(plain)).toBe(plain);
    const signed = `![chart](/api/files/${file}/content?exp=1791914560&m=${member}&sig=abc_DEF-123)`;
    expect(roundTrip(signed)).toBe(signed);
  });

  it('keeps a table with a mention and a doc link in its cells', () => {
    const md = ['| Owner | Doc |', '| --- | --- |', `| [@Ann](member:${member}) | [Plan](#/knowledge/${doc}) |`].join(
      '\n',
    );
    expect(roundTrip(md)).toBe(md);
  });
});

describe('marks Markdown can hold', () => {
  it('keeps strikethrough, and literal tildes stay text', () => {
    expect(roundTrip('Ship ~~Friday~~ Monday.')).toBe('Ship ~~Friday~~ Monday.');
    expect(roundTrip('About ~5 minutes.')).toBe('About ~5 minutes.');
    const literal: TiptapNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a ~~b~~ c' }] }],
    };
    const out = tiptapJsonToMarkdown(literal);
    expect(roundTrip(out)).toBe(out);
    expect(markdownToTiptapJson(out)).not.toContain('strike');
  });

  it('offers no underline, which Markdown cannot store', () => {
    expect(markdownToTiptapJson('<u>under</u> line')).not.toContain('underline');
  });
});

/** Markdown → editor JSON → Markdown → editor JSON: the document has to come back the same. */
function survives(md: string) {
  const first = markdownToTiptapJson(md);
  const written = tiptapJsonToMarkdown(JSON.parse(first) as TiptapNode);
  expect(markdownToTiptapJson(written)).toBe(first);
  // …and a second save writes the same Markdown.
  expect(roundTrip(written)).toBe(written);
  return written;
}

const text = (value: string, marks: string[] = []): TiptapNode => ({
  type: 'text',
  text: value,
  ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
});
const paragraph = (...content: TiptapNode[]): TiptapNode => ({ type: 'paragraph', content });
const docOf = (...content: TiptapNode[]): TiptapNode => ({ type: 'doc', content });

describe('line breaks', () => {
  it('keeps a hard break as a backslash at the end of the line', () => {
    expect(survives('line one\\\nline two')).toBe('line one\\\nline two');
    expect(markdownToEditorHtml(roundTrip('a\\\nb'))).toContain('<br>');
  });

  it('writes breaks in headings and table cells as <br>, which are one line', () => {
    const json = docOf(
      { type: 'heading', attrs: { level: 2 }, content: [text('Plan'), { type: 'hardBreak' }, text('B')] },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [{ type: 'tableHeader', content: [paragraph(text('a'), { type: 'hardBreak' }, text('b'))] }],
          },
        ],
      },
    );
    const md = tiptapJsonToMarkdown(json);
    expect(md).toContain('## Plan<br>B');
    expect(md).toContain('| a<br>b |');
    expect(roundTrip(md)).toBe(md);
  });

  it('drops a break at the end of a paragraph instead of leaving a stray backslash', () => {
    expect(tiptapJsonToMarkdown(docOf(paragraph(text('end'), { type: 'hardBreak' })))).toBe('end');
  });

  it('keeps a line that looks like a rule or a heading underline as text', () => {
    const md = tiptapJsonToMarkdown(docOf(paragraph(text('a'), { type: 'hardBreak' }, text('---'))));
    expect(markdownToTiptapJson(md)).not.toContain('heading');
    expect(markdownToTiptapJson(md)).toContain('---');
  });
});

describe('marks next to spaces and punctuation', () => {
  it('keeps the space outside the delimiters', () => {
    const md = tiptapJsonToMarkdown(docOf(paragraph(text('Note: ', ['bold']), text('rest'))));
    expect(md).toBe('**Note:** rest');
    const again = tiptapJsonToMarkdown(docOf(paragraph(text('see'), text(' this', ['italic']))));
    expect(again).toBe('see *this*');
  });

  it('writes bold that Markdown would not read next to CJK punctuation as a tag', () => {
    const md = tiptapJsonToMarkdown(docOf(paragraph(text('注意：', ['bold']), text('请看'))));
    expect(md).toBe('<strong>注意：</strong>请看');
    expect(markdownToTiptapJson(md)).toContain('"bold"');
    expect(roundTrip(md)).toBe(md);
    // Plain CJK bold stays Markdown.
    expect(survives('这是**重点**内容')).toBe('这是**重点**内容');
  });

  it('nests marks that start or end together', () => {
    expect(survives('**bold *both***')).toBe('**bold *both***');
    expect(survives('**a***b*')).toBe('**a***b*');
    expect(survives('[**bold link**](https://example.com) and ~~gone~~')).toBe(
      '[**bold link**](https://example.com) and ~~gone~~',
    );
  });

  it('keeps text that looks like HTML or an entity as text', () => {
    const md = tiptapJsonToMarkdown(docOf(paragraph(text('<b>not bold</b> &amp; ~a~'))));
    expect(markdownToTiptapJson(md)).not.toContain('"bold"');
    expect(markdownToTiptapJson(md)).toContain('<b>not bold</b> &amp; ~a~');
  });

  it('holds backticks in inline code and in code blocks', () => {
    const inline = tiptapJsonToMarkdown(docOf(paragraph(text('a`b', ['code']))));
    expect(inline).toBe('``a`b``');
    expect(survives(inline)).toBe(inline);
    const fenced = survives(['````md', '```js', 'x', '```', '````'].join('\n'));
    expect(fenced.startsWith('````md')).toBe(true);
  });

  it('keeps brackets in link text and spaces in addresses', () => {
    const md = tiptapJsonToMarkdown(
      docOf(
        paragraph({ type: 'text', text: 'a ] b', marks: [{ type: 'link', attrs: { href: 'https://x.test/a b' } }] }),
      ),
    );
    expect(md).toBe('[a \\] b](<https://x.test/a b>)');
    expect(markdownToTiptapJson(md)).toContain('a ] b');
  });

  it('keeps a heading that ends with #', () => {
    expect(survives('# Issue \\#')).toBe('# Issue \\#');
  });
});

describe('lists', () => {
  it('keeps task lists and whether each task is done', () => {
    const md = ['- [ ] write the plan', '- [x] book the room', '  - [ ] nested task'].join('\n');
    expect(markdownToTiptapJson(md)).toContain('taskItem');
    expect(survives(md)).toBe(md);
  });

  it('drops an empty task, which Markdown cannot hold, and keeps the rest a task list', () => {
    const json = docOf({
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [paragraph(text('done'))] },
        { type: 'taskItem', attrs: { checked: false }, content: [paragraph()] },
      ],
    });
    expect(tiptapJsonToMarkdown(json)).toBe('- [x] done');
  });

  it('keeps a box written in a list that also has plain items', () => {
    expect(survives('- [ ] task\n- plain')).toBe('- [ ] task\n- plain');
  });

  it('keeps where a numbered list starts', () => {
    expect(survives('3. three\n4. four')).toBe('3. three\n4. four');
  });

  it('nests under numbers as deep as their marker', () => {
    expect(survives('1. first\n   - inside\n2. second')).toBe('1. first\n   - inside\n2. second');
    expect(survives('- a\n\n  3. starts at three')).toBe('- a\n\n  3. starts at three');
  });

  it('keeps paragraphs apart inside list items and quotes', () => {
    expect(survives('- one\n\n  two\n- three')).toBe('- one\n\n  two\n- three');
    expect(survives('> one\n>\n> two')).toBe('> one\n>\n> two');
  });

  it('keeps two lists in a row apart', () => {
    expect(survives('- a\n\n* b')).toBe('- a\n\n* b');
    expect(survives('1. a\n\n1) b')).toBe('1. a\n\n1) b');
  });
});

describe('a whole doc', () => {
  it('comes back the same after a save', () => {
    const md = [
      '# 上线计划',
      '',
      '<strong>注意：</strong>周五前完成，问 [@Ann](member:mbr_01JABCDEFGHJKMNPQRSTVWXYZ0)。',
      '',
      '## Tasks',
      '',
      '- [x] Draft the **plan**',
      '- [ ] Review with `ops`\\',
      '  and legal',
      '  - [ ] Book the room',
      '',
      '3. Ship',
      '4. Announce',
      '   1. Blog',
      '   2. Mail',
      '',
      '> Quote with *emphasis*',
      '>',
      '> - and a list',
      '',
      '| Who | What |',
      '| --- | --- |',
      '| Mei | Docs<br>and tests |',
      '',
      '```ts',
      'const a = `x`;',
      '',
      '',
      'const b = 2;',
      '```',
      '',
      '---',
      '',
      '![chart](/api/files/fil_01JABCDEFGHJKMNPQRSTVWXYZ0/content "Q3")',
    ].join('\n');
    expect(survives(md)).toBe(md);
  });
});
