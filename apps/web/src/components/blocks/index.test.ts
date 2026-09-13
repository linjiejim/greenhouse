import { describe, expect, it } from 'vitest';
import { parseSegments } from './index.js';

describe('parseSegments', () => {
  it('replaces an open streaming datatable fence with a pending segment', () => {
    const segments = parseSegments('Summary\n\n```datatable\n{"columns":[{"key":"name"');

    expect(segments).toEqual([{ type: 'markdown', content: 'Summary\n\n' }, { type: 'datatable-pending' }]);
    expect(JSON.stringify(segments)).not.toContain('"columns"');
  });

  it('replaces the pending segment with a datatable after the fence closes', () => {
    const content =
      '```datatable\n' +
      JSON.stringify({
        title: 'People',
        columns: [{ key: 'name', label: 'Name' }],
        rows: [{ name: 'Ada' }],
      }) +
      '\n```';

    expect(parseSegments(content)).toEqual([
      {
        type: 'datatable',
        data: {
          title: 'People',
          columns: [{ key: 'name', label: 'Name' }],
          rows: [{ name: 'Ada' }],
        },
      },
    ]);
  });

  it('keeps a closed invalid datatable as a regular code block', () => {
    expect(parseSegments('```datatable\nnot-json\n```')).toEqual([
      { type: 'markdown', content: '```datatable\nnot-json\n```' },
    ]);
  });
});
