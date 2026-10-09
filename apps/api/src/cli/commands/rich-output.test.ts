import { describe, expect, it } from 'vitest';
import { parseSince, tallyMessages } from './rich-output.js';

describe('rich-output stats', () => {
  it('tallies outcomes and failure reasons per model and block', () => {
    const byModel = tallyMessages([
      { model: 'flash', content: '```chart\n{"labels":["a"],"values":[1]}\n```' },
      { model: 'flash', content: '```chart\n{broken\n```\n\n```mermaid\nA-->B\n```' },
      { model: null, content: 'Cut off:\n\n```datatable\n{"columns":' },
      { model: 'flash', content: '```python\nprint(1)\n```' },
    ]);

    expect(byModel.get('flash')?.get('chart')).toEqual({
      total: 2,
      ok: 1,
      invalid: 1,
      unterminated: 0,
      reasons: { json: 1 },
    });
    expect(byModel.get('flash')?.get('mermaid')).toMatchObject({ total: 1, ok: 1 });
    expect(byModel.get('(unknown)')?.get('datatable')).toMatchObject({ total: 1, unterminated: 1 });
    expect(byModel.get('flash')?.has('python')).toBe(false);
  });

  it('keeps adding to one tally across pages', () => {
    const chart = '```chart\n{"labels":["a"],"values":[1]}\n```';
    const byModel = tallyMessages([{ model: 'flash', content: chart }]);
    const same = tallyMessages([{ model: 'flash', content: chart + '\n\n```chart\n{broken\n```' }], byModel);

    expect(same).toBe(byModel);
    expect(byModel.get('flash')?.get('chart')).toMatchObject({ total: 3, ok: 2, invalid: 1 });
  });

  it('reads relative and absolute windows', () => {
    const now = new Date('2026-10-08T00:00:00Z');
    expect(parseSince('30d', now)).toBe('2026-09-08T00:00:00.000Z');
    expect(parseSince('12h', now)).toBe('2026-10-07T12:00:00.000Z');
    expect(parseSince(undefined, now)).toBe('2026-09-08T00:00:00.000Z');
    expect(parseSince('2026-10-01', now)).toBe('2026-10-01T00:00:00.000Z');
    expect(() => parseSince('last week', now)).toThrow(/--since/);
  });
});
