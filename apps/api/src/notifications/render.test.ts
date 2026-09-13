import { afterEach, describe, expect, it } from 'vitest';

import { flattenRichOutput, renderNotificationEmail } from './render.js';

const originalBaseUrl = process.env.PUBLIC_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = originalBaseUrl;
});

const datatable = [
  '```datatable',
  JSON.stringify({
    title: '2026-08-15 新增选题总览',
    columns: [
      { key: 'name', label: '标题', type: 'text' },
      { key: 'prio', label: '优先级', type: 'text' },
    ],
    rows: [
      { name: '补光灯选购', prio: '高' },
      { name: '浇水频率', prio: '中' },
    ],
  }),
  '```',
].join('\n');

describe('flattenRichOutput', () => {
  it('turns a datatable fence into a Markdown table', () => {
    const out = flattenRichOutput(`素材采集完毕。\n\n${datatable}`);

    expect(out).toContain('素材采集完毕。');
    expect(out).toContain('**2026-08-15 新增选题总览**');
    expect(out).toContain('| 标题 | 优先级 |');
    expect(out).toContain('| 补光灯选购 | 高 |');
    // The JSON payload is what the reader was seeing before.
    expect(out).not.toContain('"columns"');
    expect(out).not.toContain('```datatable');
  });

  it('keeps cell content inside its cell', () => {
    const out = flattenRichOutput(
      ['```datatable', JSON.stringify({ columns: [{ key: 'a', label: 'A' }], rows: [{ a: 'x | y\nz' }] }), '```'].join(
        '\n',
      ),
    );

    expect(out).toContain('| x \\| y z |');
    expect(out.split('\n')).toHaveLength(3); // header, divider, one row
  });

  it('renders chart data as the table it was built from', () => {
    const out = flattenRichOutput(
      [
        '```chart',
        JSON.stringify({
          type: 'bar',
          title: '月度出货',
          labels: ['一月', '二月'],
          datasets: [{ label: '台数', data: [12, 34] }],
        }),
        '```',
      ].join('\n'),
    );

    expect(out).toContain('**月度出货**');
    expect(out).toContain('| 台数 |');
    expect(out).toContain('| 一月 | 12 |');
  });

  it('replaces undrawable blocks with a note instead of dropping them', () => {
    expect(flattenRichOutput('```mermaid\ngraph TD; A-->B;\n```')).toContain('图示无法在邮件中显示');
    expect(flattenRichOutput('```html-preview\n<h1>hi</h1>\n```')).toContain('网页预览无法在邮件中显示');
  });

  it('lists mission artifacts by name and size', () => {
    const out = flattenRichOutput(
      [
        '```mission-artifacts',
        JSON.stringify([{ id: 1, run_id: 'r', path: '报告.pdf', size_bytes: 2048 }]),
        '```',
      ].join('\n'),
    );

    expect(out).toContain('**产物文件**');
    expect(out).toContain('- 报告.pdf (2 KB)');
  });

  it('drops a datatable that was cut off mid-stream', () => {
    // An interrupted turn leaves an open fence; there are no rows to show and
    // announcing a table that never arrived would be worse than silence.
    expect(flattenRichOutput('结果如下\n\n```datatable\n{"columns":')).toBe('结果如下');
  });

  it('leaves ordinary Markdown alone', () => {
    const md = '## 标题\n\n- 一\n- 二\n\n| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(flattenRichOutput(md)).toBe(md);
  });

  it('is empty for an empty summary', () => {
    expect(flattenRichOutput('')).toBe('');
    expect(flattenRichOutput('   \n ')).toBe('');
  });
});

describe('renderNotificationEmail', () => {
  it('renders Markdown as HTML rather than as text', () => {
    const html = renderNotificationEmail({ heading: '✅ 每日选题', body: flattenRichOutput(datatable) });

    expect(html).toContain('<table>');
    expect(html).toContain('<th>标题</th>');
    expect(html).toContain('<td>补光灯选购</td>');
    expect(html).toContain('✅ 每日选题');
    expect(html).not.toContain('| 标题 |');
  });

  it('neutralises model-authored HTML', () => {
    const html = renderNotificationEmail({ heading: 'x', body: '<script>alert(1)</script>\n\nhello' });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes the heading too', () => {
    expect(renderNotificationEmail({ heading: '<b>x</b>', body: '' })).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('resolves site-relative URLs against the public base', () => {
    process.env.PUBLIC_BASE_URL = 'https://greenhouse.example.com/';
    const html = renderNotificationEmail({ heading: 'x', body: '![图](/api/upload/abc)' });

    expect(html).toContain('src="https://greenhouse.example.com/api/upload/abc"');
  });

  it('drops links a mail client cannot follow, keeping their text', () => {
    const html = renderNotificationEmail({
      heading: 'x',
      body: '[会话](#/chat/123) and [evil](javascript:alert(1))',
    });

    expect(html).not.toContain('href="#/chat/123"');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('会话');
    expect(html).toContain('evil');
  });

  it('renders the session link as a button when there is one', () => {
    const html = renderNotificationEmail({
      heading: 'x',
      body: 'done',
      link: { url: 'https://greenhouse.example.com/#/chat/1', label: '打开会话' },
    });

    expect(html).toContain('href="https://greenhouse.example.com/#/chat/1"');
    expect(html).toContain('打开会话');
  });
});
