/**
 * A model that abandons a block mid-thought must not take the chat down with
 * it. Session c0b6bf83 on dev emitted a datatable fence with columns and no
 * rows; every render of that session threw "Cannot read properties of
 * undefined (reading 'length')", so the conversation could not be opened.
 *
 * Rendering is asserted through renderToStaticMarkup, which has no DOM — the
 * markdown segments the fallback produces are asserted at the parse level.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichMarkdown } from '../rich-markdown.js';
import { parseSegments } from './index.js';

const fence = (type: string, payload: unknown) => '```' + type + '\n' + JSON.stringify(payload) + '\n```';
const render = (content: string) => renderToStaticMarkup(createElement(RichMarkdown, { content, compact: true }));

describe('malformed custom blocks', () => {
  it('renders the abandoned datatable from session c0b6bf83 as an empty table', () => {
    const html = render(
      fence('datatable', {
        title: 'Neil Peng 的客户（按累计销售额 Top 10）',
        columns: [
          { key: 'rank', label: '#', type: 'number' },
          { key: 'name', label: '客户名称', type: 'text' },
        ],
      }),
    );

    expect(html).toContain('Neil Peng');
    expect(html).toContain('客户名称');
    expect(html).toContain('0 row');
  });

  it('treats non-array rows as no rows', () => {
    const html = render(fence('datatable', { columns: [{ key: 'name', label: 'Name' }], rows: 'none' }));

    expect(html).toContain('0 row');
  });

  it('still renders the rows a well-formed datatable carries', () => {
    const html = render(
      fence('datatable', { columns: [{ key: 'name', label: 'Name' }], rows: [{ name: 'Ada' }, { name: 'Grace' }] }),
    );

    expect(html).toContain('Ada');
    expect(html).toContain('Grace');
    expect(html).toContain('2 row');
  });
});

describe('parseSegments rejects unrenderable block payloads', () => {
  const asCodeBlock = (content: string) => [{ type: 'markdown', content }];

  it('keeps a datatable without usable columns as a code block', () => {
    const raw = fence('datatable', { title: 'No columns', rows: [{ a: 1 }] });

    expect(parseSegments(raw)).toEqual(asCodeBlock(raw));
  });

  it('keeps a chart without datasets as a code block', () => {
    const raw = fence('chart', { type: 'bar', labels: ['a', 'b'] });

    expect(parseSegments(raw)).toEqual(asCodeBlock(raw));
  });

  it('keeps a chart with an unsupported type as a code block', () => {
    const raw = fence('chart', { type: 'sankey', labels: ['a'], datasets: [{ label: 'x', data: [1] }] });

    expect(parseSegments(raw)).toEqual(asCodeBlock(raw));
  });

  it('keeps a confirm without actions as a code block', () => {
    const raw = fence('confirm', { text: 'Delete everything?' });

    expect(parseSegments(raw)).toEqual(asCodeBlock(raw));
  });

  it('drops rows that are not objects rather than rendering junk', () => {
    const segments = parseSegments(
      fence('datatable', { columns: [{ key: 'name', label: 'Name' }], rows: [{ name: 'Ada' }, 'nope', null] }),
    );

    expect(segments).toEqual([
      { type: 'datatable', data: { columns: [{ key: 'name', label: 'Name' }], rows: [{ name: 'Ada' }] } },
    ]);
  });
});
