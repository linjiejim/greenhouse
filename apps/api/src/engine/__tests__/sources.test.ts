import { describe, expect, it } from 'vitest';
import { createSources } from '../sources.js';

const page = (url: string, title = url) => ({ kind: 'web', id: url, title, url });

describe('reply sources', () => {
  it('keeps pages read, and search results only when the reply links them', () => {
    const sources = createSources();
    sources.cite(page('https://a.example/one', 'One'), 'seen');
    sources.cite(page('https://b.example/two/', 'Two'), 'seen');
    sources.cite(page('https://c.example/three', 'Three'), 'seen');
    sources.cite(page('https://a.example/one', 'One'), 'read');
    expect(sources.citations('See https://b.example/two for more.').map((source) => source.title)).toEqual([
      'One',
      'Two',
    ]);
    expect(sources.citations('Nothing linked.').map((source) => source.title)).toEqual(['One']);
  });

  it('shows at most eight', () => {
    const sources = createSources();
    for (let index = 0; index < 12; index++) sources.cite(page(`https://x.example/${index}`), 'read');
    expect(sources.citations('')).toHaveLength(8);
  });
});
