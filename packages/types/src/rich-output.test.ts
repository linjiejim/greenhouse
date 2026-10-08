import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLIENT_BLOCKS,
  DEFAULT_FLATTEN_NOTES,
  MODEL_FENCES,
  RICH_BLOCKS,
  RICH_OUTPUT_LIMITS,
  admitRichBlocks,
  diagnoseRichOutput,
  findIncompleteRichBlock,
  flattenRichOutput,
  isChartData,
  isConfirmData,
  isDataTableData,
  parseSegments,
  type RichFence,
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

    expect(segments).toEqual([
      { type: 'markdown', content: 'Summary\n\n' },
      { type: 'pending', fence: 'datatable' },
    ]);
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

  it('hides an unclosed mermaid fence behind a pending segment until it closes', () => {
    // Half a diagram is not a diagram — the renderer reserves space while the
    // model is still writing, and draws the figure once the fence closes.
    const partial = 'Here:\n\n```mermaid\nflowchart LR\n  A --> ';

    expect(parseSegments(partial)).toEqual([
      { type: 'markdown', content: 'Here:\n\n' },
      { type: 'pending', fence: 'mermaid' },
    ]);
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

// ─── Registry-derived behaviour ──────────────────────────

/**
 * One valid body per registered fence. Typed as a full record so registering a
 * new block fails to compile here until it has a sample — and then every
 * derived behaviour below is checked for it with no other test edits.
 */
const SAMPLES: Record<RichFence, string> = {
  chart: JSON.stringify({ type: 'bar', labels: ['A'], datasets: [{ label: 'S', data: [1] }] }),
  datatable: JSON.stringify({ columns: [{ key: 'name', label: 'Name' }], rows: [{ name: 'x' }] }),
  confirm: JSON.stringify({ text: 'Go?', actions: [{ label: 'Yes', value: 'yes' }] }),
  mermaid: 'flowchart LR\n  A --> B',
  'html-preview': '<!doctype html><title>T</title><p>hi</p>',
  'mission-artifacts': JSON.stringify([{ id: 1, run_id: 'r', path: 'out.txt', size_bytes: 2048 }]),
  attachments: JSON.stringify([{ id: 'f1', name: 'a.pdf' }]),
};

describe('Rich Output registry', () => {
  it.each(RICH_BLOCKS.map((def) => [def.fence, def] as const))('%s: parse, pending, trim, flatten', (fence, def) => {
    const body = SAMPLES[fence];
    const closed = `Intro\n\n\`\`\`${fence}\n${body}\n\`\`\``;
    const segments = parseSegments(closed);
    expect(segments[1]?.type).toBe(fence);
    expect(diagnoseRichOutput(closed)).toEqual([{ fence, outcome: 'ok' }]);

    const open = `Intro\n\n\`\`\`${fence}\n${body.slice(0, 5)}`;
    expect(parseSegments(open)).toEqual([
      { type: 'markdown', content: 'Intro\n\n' },
      { type: 'pending', fence },
    ]);
    expect(findIncompleteRichBlock(open)).toBe('Intro\n\n'.length);
    expect(findIncompleteRichBlock(closed)).toBeNull();
    expect(diagnoseRichOutput(open)).toEqual([{ fence, outcome: 'unterminated' }]);

    // Stand-ins that never echo source, so any leftover fence is the registry's fault.
    const notes = { ...DEFAULT_FLATTEN_NOTES, diagram: () => '(diagram)', preview: () => '(page)' };
    expect(flattenRichOutput(closed, notes)).not.toContain('```' + fence);
    if (def.author === 'model') expect(MODEL_FENCES).toContain(fence);
  });

  it('reads historical aliases into the canonical segment', () => {
    const legacy = '```mission-attachments\n' + SAMPLES.attachments + '\n```';
    expect(parseSegments(legacy)).toEqual([{ type: 'attachments', data: [{ id: 'f1', name: 'a.pdf' }] }]);
  });

  it('classifies why a block fell back', () => {
    const md = [
      '```chart\n{not json\n```',
      '```datatable\n{"columns":[{"key":"a"}],"rows":[]}\n```',
      '```mermaid\n\n```',
      '```confirm\n' +
        JSON.stringify({ text: 'x', actions: Array.from({ length: 21 }, () => ({ label: 'a', value: 'a' })) }) +
        '\n```',
    ].join('\n\n');
    expect(diagnoseRichOutput(md)).toEqual([
      { fence: 'chart', outcome: 'invalid', reason: 'json' },
      { fence: 'datatable', outcome: 'invalid', reason: 'shape' },
      { fence: 'mermaid', outcome: 'invalid', reason: 'empty' },
      { fence: 'confirm', outcome: 'invalid', reason: 'too_large' },
    ]);
  });

  it('ignores fences it does not own', () => {
    expect(diagnoseRichOutput('```python\nprint(1)\n```\n\n```html\n<b>x</b>\n```')).toEqual([]);
    expect(findIncompleteRichBlock('```python\nprint(1)')).toBeNull();
  });
});

describe('chart normalization', () => {
  const chart = (payload: unknown) => parseSegments(fence('chart', payload))[0];

  it('accepts the loose point-list form as one series', () => {
    expect(
      chart({
        type: 'pie',
        title: 'Share',
        data: [
          { name: 'A', value: 3 },
          { label: 'B', count: '5' },
        ],
      }),
    ).toEqual({
      type: 'chart',
      data: { type: 'pie', title: 'Share', labels: ['A', 'B'], datasets: [{ label: 'Share', data: [3, 5] }] },
    });
  });

  it('accepts parallel categories + values arrays and pads missing labels', () => {
    expect(chart({ categories: ['Q1'], values: [1, 2] })).toEqual({
      type: 'chart',
      data: { type: 'bar', labels: ['Q1', '2'], datasets: [{ label: '', data: [1, 2] }] },
    });
  });

  it('draws an unknown type as bars and coerces numeric strings', () => {
    expect(chart({ type: 'area', labels: ['a'], datasets: [{ label: 'S', data: ['4.5'] }] })).toEqual({
      type: 'chart',
      data: { type: 'bar', labels: ['a'], datasets: [{ label: 'S', data: [4.5] }] },
    });
  });

  it('still rejects a point it cannot plot', () => {
    expect(chart({ labels: ['a'], values: ['n/a'] })).toMatchObject({ type: 'markdown' });
    expect(chart({ labels: ['a'] })).toMatchObject({ type: 'markdown' });
  });
});

describe('flattenRichOutput', () => {
  it('turns charts and tables into Markdown tables with the default notes', () => {
    const out = flattenRichOutput(
      'Result\n\n' +
        fence('chart', { type: 'bar', title: 'Sales', labels: ['Q1'], datasets: [{ label: '2026', data: [3] }] }) +
        '\n\n' +
        fence('datatable', { columns: [{ key: 'ok', label: 'OK' }], rows: [{ ok: true }] }),
    );
    expect(out).toBe('Result\n\n**Sales**\n\n|  | 2026 |\n| --- | --- |\n| Q1 | 3 |\n\n| OK |\n| --- |\n| true |');
  });

  it('keeps diagram source by default and lets the caller replace it', () => {
    const md = '```mermaid\nA-->B\n```';
    expect(flattenRichOutput(md)).toBe('```mermaid\nA-->B\n```');
    expect(flattenRichOutput(md, { ...DEFAULT_FLATTEN_NOTES, diagram: () => '(diagram)' })).toBe('(diagram)');
  });

  it('drops an unterminated block entirely', () => {
    expect(flattenRichOutput('Done\n\n```datatable\n{"columns":')).toBe('Done');
  });
});

describe('admitRichBlocks', () => {
  it('teaches the default set when nothing is declared', () => {
    expect(admitRichBlocks(undefined)).toBeUndefined();
    expect(admitRichBlocks('chart')).toBeUndefined();
  });

  it('keeps only known model fences, in registry order', () => {
    expect(admitRichBlocks(['mermaid', 'nope', 'chart', 'attachments', 3])).toEqual(['chart', 'mermaid']);
    expect(admitRichBlocks([])).toEqual([]);
  });

  it('defaults to exactly the five blocks every client drew before capabilities existed', () => {
    expect(DEFAULT_CLIENT_BLOCKS).toEqual(['chart', 'datatable', 'confirm', 'mermaid', 'html-preview']);
  });
});
