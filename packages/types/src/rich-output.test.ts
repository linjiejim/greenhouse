import { describe, expect, it, vi } from 'vitest';
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
  htmlBridgeSource,
  injectHtmlBridge,
  latestWithin,
  readHtmlBridgeMessage,
  isChartData,
  isConfirmData,
  isDataTableData,
  parseSegments,
  resolveBlockAction,
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

    // `raw` is for a settled message that ends mid-block (rendered as a code
    // block); while streaming, renderers show only the placeholder.
    expect(segments).toEqual([
      { type: 'markdown', content: 'Summary\n\n' },
      { type: 'pending', fence: 'datatable', raw: '```datatable\n{"columns":[{"key":"name"' },
    ]);
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
      { type: 'pending', fence: 'mermaid', raw: '```mermaid\nflowchart LR\n  A --> ' },
    ]);
  });

  it('drops an empty mermaid fence and falls back to a code block for an oversized one', () => {
    const empty = parseSegments('Before\n\n```mermaid\n\n```\n\nAfter');
    const huge = parseSegments('```mermaid\n' + 'A --> B\n'.repeat(RICH_OUTPUT_LIMITS.mermaidChars) + '```');

    // An empty block says nothing: it disappears instead of showing an empty code block.
    expect(empty).toEqual([
      { type: 'markdown', content: 'Before\n\n' },
      { type: 'markdown', content: '\n\nAfter' },
    ]);
    expect(huge[0]).toMatchObject({ type: 'markdown', content: expect.stringContaining('```mermaid') });
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
  stats: JSON.stringify({ items: [{ label: 'New customers', value: 128 }] }),
  cards: JSON.stringify({ items: [{ title: 'Site redesign', url: '#/projects/42' }] }),
  steps: JSON.stringify({ items: [{ title: 'Review', status: 'done' }] }),
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
      { type: 'pending', fence, raw: open.slice('Intro\n\n'.length) },
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

describe('business blocks', () => {
  const block = (type: string, payload: unknown) => parseSegments(fence(type, payload))[0];

  it('accepts stats and keeps direction and colour apart', () => {
    expect(
      block('stats', {
        title: 'October',
        items: [
          { label: 'Cost', value: 4200, unit: 'USD', delta: '+8%', trend: 'up', tone: 'negative', hint: 'vs Sep' },
        ],
        actions: [{ label: 'Break down', value: 'Break October cost down by team' }],
      }),
    ).toEqual({
      type: 'stats',
      data: {
        title: 'October',
        items: [
          { label: 'Cost', value: 4200, unit: 'USD', delta: '+8%', trend: 'up', tone: 'negative', hint: 'vs Sep' },
        ],
        actions: [{ label: 'Break down', value: 'Break October cost down by team' }],
      },
    });
  });

  it('clips over-long text instead of throwing the block away, but stays strict on structure', () => {
    const long = 'x'.repeat(100);
    const stats = block('stats', { items: [{ label: long, value: 1 }] });
    expect(stats).toMatchObject({ type: 'stats' });
    expect((stats as { data: { items: { label: string }[] } }).data.items[0]!.label).toHaveLength(40);

    // An empty block (models leave one behind after changing their mind) renders nothing.
    expect(parseSegments('Done.\n\n' + fence('steps', { title: '', items: [] }))).toEqual([
      { type: 'markdown', content: 'Done.\n\n' },
    ]);
    expect(diagnoseRichOutput(fence('stats', { items: [] }))).toEqual([
      { fence: 'stats', outcome: 'invalid', reason: 'empty' },
    ]);
    expect(block('stats', { items: Array.from({ length: 9 }, (_, i) => ({ label: 'a', value: i })) })).toMatchObject({
      type: 'markdown',
    });
    expect(block('stats', { items: [{ label: 'a', value: {} }] })).toMatchObject({ type: 'markdown' });
  });

  it('only lets a card link to an in-app route or http(s)', () => {
    expect(block('cards', { items: [{ title: 'Doc', url: 'https://example.com/a' }] })).toMatchObject({
      type: 'cards',
    });
    expect(block('cards', { items: [{ title: 'Doc', url: 'javascript:alert(1)' }] })).toMatchObject({
      type: 'markdown',
    });
    expect(block('cards', { items: [{ title: 'Doc', url: '/api/secret' }] })).toMatchObject({ type: 'markdown' });
  });

  it('keeps card badges and fields within their caps', () => {
    const card = {
      title: 'Site redesign',
      badges: [
        { label: 'Late', tone: 'danger' },
        { label: 'Odd', tone: 'purple' },
      ],
      fields: [{ label: 'Due', value: '10-15' }],
    };
    expect(block('cards', { items: [card] })).toEqual({
      type: 'cards',
      data: {
        items: [
          {
            title: 'Site redesign',
            badges: [{ label: 'Late', tone: 'danger' }, { label: 'Odd' }],
            fields: [{ label: 'Due', value: '10-15' }],
          },
        ],
      },
    });
    expect(
      block('cards', { items: [{ ...card, badges: Array.from({ length: 4 }, () => ({ label: 'b' })) }] }),
    ).toMatchObject({
      type: 'markdown',
    });
  });

  it('requires a known status on every step', () => {
    expect(block('steps', { items: [{ title: 'Build', status: 'active' }] })).toMatchObject({ type: 'steps' });
    expect(block('steps', { items: [{ title: 'Build', status: 'doing' }] })).toMatchObject({ type: 'markdown' });
  });

  it('caps block actions at four', () => {
    const actions = Array.from({ length: 5 }, (_, i) => ({ label: `a${i}`, value: `v${i}` }));
    expect(block('steps', { items: [{ title: 'Build', status: 'done' }], actions })).toMatchObject({
      type: 'markdown',
    });
  });

  it('flattens to readable Markdown', () => {
    const md = [
      fence('stats', { title: 'Oct', items: [{ label: 'New', value: 128, unit: 'users', delta: '+12%' }] }),
      fence('cards', {
        items: [{ title: 'Redesign', url: '#/projects/42', subtitle: 'Owner Ann', badges: [{ label: 'Late' }] }],
      }),
      fence('steps', {
        items: [
          { title: 'Review', status: 'done', time: '10-02' },
          { title: 'Build', status: 'active' },
        ],
      }),
    ].join('\n\n');
    expect(flattenRichOutput(md)).toBe(
      [
        '**Oct**\n\n- **New**: 128 users (+12%)',
        '- [Redesign](#/projects/42) — Owner Ann · Late',
        '- [x] Review (10-02)\n- [ ] Build (in progress)',
      ].join('\n\n'),
    );
  });

  it('resolves which button was pressed from the next message only', () => {
    const actions = [
      { label: 'A', value: 'do a' },
      { label: 'B', value: 'do b' },
    ];
    expect(resolveBlockAction(actions, 'do b')).toBe('do b');
    expect(resolveBlockAction(actions, 'something else')).toBeNull();
    expect(resolveBlockAction(undefined, 'do a')).toBeNull();
    expect(resolveBlockAction(actions, undefined)).toBeNull();
  });
});

describe('html-preview bridge', () => {
  it('injects the page API inside <head>, keeping the doctype first', () => {
    const page = '<!doctype html><html><head><title>Calc</title></head><body></body></html>';
    const out = injectHtmlBridge(page);
    expect(out.startsWith('<!doctype html><html><head><script>')).toBe(true);
    expect(out).toContain('window.greenhouse = Object.freeze');
    expect(out).toContain('parent.postMessage');
    expect(injectHtmlBridge('<p>bare</p>').startsWith('<script>')).toBe(true);
  });

  it('builds a React Native flavour that posts a string', () => {
    expect(htmlBridgeSource('react-native')).toContain('ReactNativeWebView.postMessage(JSON.stringify(message))');
  });

  it('reads only well-formed messages, from either transport, and caps their length', () => {
    expect(readHtmlBridgeMessage({ type: 'greenhouse:prompt', text: '  hi  ' })).toEqual({
      text: 'hi',
      truncated: false,
    });
    expect(readHtmlBridgeMessage(JSON.stringify({ type: 'greenhouse:prompt', text: 'hi' }))).toEqual({
      text: 'hi',
      truncated: false,
    });
    expect(readHtmlBridgeMessage({ type: 'greenhouse:print', text: 'x' })).toBeNull();
    expect(readHtmlBridgeMessage({ type: 'greenhouse:prompt', text: '   ' })).toBeNull();
    expect(readHtmlBridgeMessage('not json')).toBeNull();
    const long = readHtmlBridgeMessage({ type: 'greenhouse:prompt', text: 'x'.repeat(2_500) });
    expect(long?.text).toHaveLength(2_000);
    expect(long?.truncated).toBe(true);
  });

  it('collapses a burst into the last value', () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const fill = latestWithin<string>(1_000, (value) => seen.push(value));
      fill.push('a');
      fill.push('b');
      vi.advanceTimersByTime(999);
      expect(seen).toEqual([]);
      fill.push('c');
      vi.advanceTimersByTime(1);
      expect(seen).toEqual(['c']);
      fill.push('d');
      fill.cancel();
      vi.advanceTimersByTime(2_000);
      expect(seen).toEqual(['c']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('admits the bridge as a capability alongside blocks', () => {
    expect(admitRichBlocks(['html-preview', 'html-preview-bridge'])).toEqual(['html-preview', 'html-preview-bridge']);
  });
});

describe('JSON repair', () => {
  it('closes brackets a model left off the very end, then validates as usual', () => {
    const body = '{"items":[{"title":"Doc","fields":[{"label":"Due","value":"10-31"}]}]';
    expect(parseSegments('```cards\n' + body + '\n```')[0]).toMatchObject({ type: 'cards' });
  });

  it('repairs nothing else', () => {
    expect(diagnoseRichOutput('```cards\n{"items":[{"title":"a}\n```')).toEqual([
      { fence: 'cards', outcome: 'invalid', reason: 'json' },
    ]);
    expect(diagnoseRichOutput('```stats\n{"items":[{"label":"a","value":1}]]}\n```')).toEqual([
      { fence: 'stats', outcome: 'invalid', reason: 'json' },
    ]);
  });
});
