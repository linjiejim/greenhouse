import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLIENT_BLOCKS,
  MODEL_FENCES,
  RICH_OUTPUT_LIMITS,
  admitRichBlocks,
  cardsMarkdown,
  isChartData,
  isConfirmData,
  isDataTableData,
  parseSegments,
  resolveBlockAction,
  statsMarkdown,
  stepsMarkdown,
} from './rich-output.js';

const fence = (type: string, payload: unknown) => `\`\`\`${type}\n${JSON.stringify(payload)}\n\`\`\``;

describe('Rich Output parser', () => {
  it('parses valid chart, datatable, and confirm fences', () => {
    const chart = {
      type: 'line',
      title: 'Moisture',
      labels: ['Mon', 'Tue'],
      datasets: [{ label: 'Zone A', data: [43, 47] }],
    } as const;
    const datatable = {
      title: 'Devices',
      columns: [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'online', label: 'Online', type: 'boolean' },
      ],
      rows: [{ name: 'LPH-01', online: true }],
    } as const;
    const confirm = {
      text: 'Apply this change?',
      actions: [
        { label: 'Apply', value: 'yes', variant: 'primary' },
        { label: 'Cancel', value: 'no', variant: 'secondary' },
      ],
    } as const;

    expect(
      parseSegments([fence('chart', chart), fence('datatable', datatable), fence('confirm', confirm)].join('\n')),
    ).toEqual([
      { type: 'chart', data: chart },
      { type: 'datatable', data: datatable },
      { type: 'confirm', data: confirm },
    ]);
    expect(isChartData(chart)).toBe(true);
    expect(isDataTableData(datatable)).toBe(true);
    expect(isConfirmData(confirm)).toBe(true);
  });

  it('falls back to ordinary Markdown for malformed closed fences', () => {
    const malformedChart = fence('chart', {
      type: 'line',
      labels: ['Mon'],
      datasets: [{ label: 'Zone A', data: ['not-a-number'] }],
    });
    const malformedTable = fence('datatable', {
      columns: [{ key: 'name' }],
      rows: [{ name: 'LPH-01' }],
    });
    const malformedConfirm = fence('confirm', { text: 'Proceed?', actions: [] });

    expect(parseSegments(malformedChart)).toEqual([{ type: 'markdown', content: malformedChart }]);
    expect(parseSegments(malformedTable)).toEqual([{ type: 'markdown', content: malformedTable }]);
    expect(parseSegments(malformedConfirm)).toEqual([{ type: 'markdown', content: malformedConfirm }]);
  });

  it('hides an unfinished streaming datatable payload behind a pending segment', () => {
    const segments = parseSegments('Summary\n\n```datatable\n{"columns":[{"key":"name"');

    expect(segments).toEqual([{ type: 'markdown', content: 'Summary\n\n' }, { type: 'datatable-pending' }]);
    expect(JSON.stringify(segments)).not.toContain('"columns"');
  });

  it('rejects blocks that exceed renderer-safe collection limits', () => {
    const tooManyRows = fence('datatable', {
      columns: [{ key: 'value', label: 'Value' }],
      rows: Array.from({ length: RICH_OUTPUT_LIMITS.dataTableRows + 1 }, (_, value) => ({ value })),
    });
    const tooManyPoints = fence('chart', {
      type: 'line',
      labels: ['Value'],
      datasets: [
        {
          label: 'Series',
          data: Array.from({ length: RICH_OUTPUT_LIMITS.chartPointsPerDataset + 1 }, (_, value) => value),
        },
      ],
    });

    expect(parseSegments(tooManyRows)).toEqual([{ type: 'markdown', content: tooManyRows }]);
    expect(parseSegments(tooManyPoints)).toEqual([{ type: 'markdown', content: tooManyPoints }]);
  });

  it('keeps a mermaid fence as source rather than parsing it as JSON', () => {
    const diagram = 'flowchart LR\n  A[下单] --> B{库存充足?}\n  B -->|是| C[出库]';

    expect(parseSegments('先看流程：\n\n```mermaid\n' + diagram + '\n```')).toEqual([
      { type: 'markdown', content: '先看流程：\n\n' },
      { type: 'mermaid', code: diagram },
    ]);
  });

  it('leaves an unclosed mermaid fence as ordinary markdown until it closes', () => {
    // Half a diagram is not a diagram — it renders as a code block while the
    // model is still writing, and becomes a figure only once the fence closes.
    const partial = 'Here:\n\n```mermaid\nflowchart LR\n  A --> ';

    expect(parseSegments(partial)).toEqual([{ type: 'markdown', content: partial }]);
  });

  it('falls back to a code block for empty or oversized mermaid payloads', () => {
    const empty = parseSegments('```mermaid\n\n```');
    const huge = parseSegments('```mermaid\n' + 'A --> B\n'.repeat(RICH_OUTPUT_LIMITS.mermaidChars) + '```');

    // The fence is preserved as markdown (the reconstruction normalizes blank
    // lines, so assert the shape rather than byte equality).
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ type: 'markdown', content: expect.stringContaining('```mermaid') });
    expect(huge[0]).toMatchObject({ type: 'markdown' });
  });

  it('keeps an html-preview fence as source and lifts its <title>', () => {
    const page = '<!doctype html><html><head><title>报价计算器</title></head><body>hi</body></html>';

    expect(parseSegments('```html-preview\n' + page + '\n```')).toEqual([
      { type: 'html-preview', code: page, title: '报价计算器' },
    ]);
  });

  it('leaves a plain ```html fence alone so code display still works', () => {
    // Claiming ```html would turn "give me the snippet" into an un-copyable
    // preview card; the preview fence is deliberately a different name.
    const snippet = '```html\n<div class="card">hi</div>\n```';

    expect(parseSegments(snippet)).toEqual([{ type: 'markdown', content: snippet }]);
  });

  it('rejects non-finite numeric values before they reach a renderer', () => {
    const nonFiniteChart =
      '```chart\n{"type":"line","labels":["Value"],"datasets":[{"label":"Series","data":[1e400]}]}\n```';
    const nonFiniteTable = '```datatable\n{"columns":[{"key":"value","label":"Value"}],"rows":[{"value":1e400}]}\n```';

    expect(parseSegments(nonFiniteChart)).toEqual([{ type: 'markdown', content: nonFiniteChart }]);
    expect(parseSegments(nonFiniteTable)).toEqual([{ type: 'markdown', content: nonFiniteTable }]);
    expect(
      isChartData({
        type: 'line',
        labels: ['Value'],
        datasets: [{ label: 'Series', data: [Number.POSITIVE_INFINITY] }],
      }),
    ).toBe(false);
  });
});

describe('stats / cards / steps blocks', () => {
  const block = (type: string, payload: unknown) => parseSegments(fence(type, payload))[0];

  it('accepts stats and keeps direction and colour apart', () => {
    expect(
      block('stats', {
        title: 'October',
        items: [{ label: 'Cost', value: 1200, unit: '$', delta: '+8%', trend: 'up', tone: 'negative', hint: 'vs Sep' }],
      }),
    ).toEqual({
      type: 'stats',
      data: {
        title: 'October',
        items: [{ label: 'Cost', value: 1200, unit: '$', delta: '+8%', trend: 'up', tone: 'negative', hint: 'vs Sep' }],
      },
    });
  });

  it('cuts wordy text instead of rejecting the block, but keeps structure strict', () => {
    const stats = block('stats', { items: [{ label: 'x'.repeat(100), value: 1 }] });
    expect(stats).toMatchObject({ type: 'stats' });
    expect((stats as { data: { items: { label: string }[] } }).data.items[0]!.label).toHaveLength(40);
    expect(block('stats', { items: [] })).toMatchObject({ type: 'markdown' });
    expect(block('stats', { items: Array.from({ length: 9 }, (_, i) => ({ label: 'a', value: i })) })).toMatchObject({
      type: 'markdown',
    });
    expect(block('stats', { items: [{ label: 'a', value: {} }] })).toMatchObject({ type: 'markdown' });
  });

  it('only lets cards link in-app routes or http(s) URLs', () => {
    expect(block('cards', { items: [{ title: 'Doc', url: '#/projects/42' }] })).toMatchObject({ type: 'cards' });
    expect(block('cards', { items: [{ title: 'Doc', url: 'https://example.com/a' }] })).toMatchObject({
      type: 'cards',
    });
    expect(block('cards', { items: [{ title: 'Doc', url: 'javascript:alert(1)' }] })).toMatchObject({
      type: 'markdown',
    });
    expect(block('cards', { items: [{ title: 'Doc', url: '/api/secret' }] })).toMatchObject({ type: 'markdown' });
    expect(
      block('cards', { items: [{ title: 'Doc', badges: Array.from({ length: 4 }, () => ({ label: 'b' })) }] }),
    ).toMatchObject({ type: 'markdown' });
  });

  it('checks step statuses and block actions', () => {
    expect(block('steps', { items: [{ title: 'Build', status: 'active' }] })).toMatchObject({ type: 'steps' });
    expect(block('steps', { items: [{ title: 'Build', status: 'doing' }] })).toMatchObject({ type: 'markdown' });
    const actions = [{ label: 'Split by industry', value: 'Split October customers by industry' }];
    expect(block('steps', { items: [{ title: 'Build', status: 'done' }], actions })).toMatchObject({
      type: 'steps',
      data: { actions },
    });
    expect(
      block('stats', {
        items: [{ label: 'a', value: 1 }],
        actions: Array.from({ length: 5 }, (_, i) => ({ label: `b${i}`, value: `v${i}` })),
      }),
    ).toMatchObject({ type: 'markdown' });
  });

  it('resolves which button the next message pressed', () => {
    const actions = [
      { label: 'Yes', value: 'Go ahead with the plan' },
      { label: 'No', value: 'Stop here' },
    ];
    expect(resolveBlockAction(actions, '  Stop here ')).toBe('Stop here');
    expect(resolveBlockAction(actions, 'something else')).toBeNull();
    expect(resolveBlockAction(actions, null)).toBeNull();
  });

  it('degrades to plain Markdown', () => {
    expect(statsMarkdown({ title: 'Oct', items: [{ label: 'New', value: 128, unit: 'users', delta: '+12%' }] })).toBe(
      '**Oct**\n\n- **New**: 128 users (+12%)',
    );
    expect(
      cardsMarkdown({
        items: [{ title: 'Site [v2]', url: '#/projects/4', subtitle: 'Owner Ann', badges: [{ label: 'Late' }] }],
      }),
    ).toBe('- [Site \\[v2\\]](#/projects/4) — Owner Ann · Late');
    expect(
      stepsMarkdown({
        items: [
          { title: 'Review', status: 'done', time: '10-02' },
          { title: 'Build', status: 'active', detail: 'front end 60%' },
          { title: 'Ship', status: 'pending' },
        ],
      }),
    ).toBe('- [x] Review (10-02)\n- [ ] Build (in progress) — front end 60%\n- [ ] Ship');
  });
});

describe('rich block capabilities', () => {
  it('admits the declared model blocks only', () => {
    expect(admitRichBlocks(undefined)).toBeUndefined();
    expect(admitRichBlocks('chart')).toBeUndefined();
    expect(admitRichBlocks(['steps', 'chart', 'bogus', 7])).toEqual(['chart', 'steps']);
    expect(admitRichBlocks([])).toEqual([]);
  });

  it('keeps old clients on the five original blocks', () => {
    expect(DEFAULT_CLIENT_BLOCKS).toEqual(['chart', 'datatable', 'confirm', 'mermaid', 'html-preview']);
    expect(MODEL_FENCES).toEqual(expect.arrayContaining([...DEFAULT_CLIENT_BLOCKS, 'stats', 'cards', 'steps']));
  });
});
