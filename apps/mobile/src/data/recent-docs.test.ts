import { describe, expect, it } from 'vitest';
import type { KbDoc } from '../shared/greenhouse-types';
import { dropped, parseRecent, parseSaved, RECENT_MAX, toSaved, withOpened } from './recent-docs';

describe('recently opened documents', () => {
  it('moves a reopened document to the top and caps the list', () => {
    let list = withOpened([], { id: 1, title: 'A' }, 1);
    list = withOpened(list, { id: 2, title: 'B' }, 2);
    list = withOpened(list, { id: 1, title: 'A2' }, 3);
    expect(list.map((e) => [e.id, e.title])).toEqual([
      [1, 'A2'],
      [2, 'B'],
    ]);
    let long = list;
    for (let i = 10; i < 10 + RECENT_MAX; i++) long = withOpened(long, { id: i, title: `D${i}` }, i);
    expect(long).toHaveLength(RECENT_MAX);
    expect(dropped(list, long).sort()).toEqual([1, 2]);
  });

  it('reads back what it wrote and nothing else', () => {
    const doc = {
      id: 7,
      slug: 's',
      title: 'Handbook',
      content_markdown: '# Hi',
      visibility: 'team',
      updated_at: 'x',
      folder_id: null,
      summary: 'not saved',
    } as unknown as KbDoc;
    const saved = toSaved(doc, 5);
    expect(saved.doc).not.toHaveProperty('summary');
    expect(parseSaved(JSON.parse(JSON.stringify(saved)), 7)).toEqual(saved);
    expect(parseSaved(saved, 8)).toBeNull();
    expect(parseRecent([{ id: 1, title: 't', openedAt: 1 }, { id: 'x' }])).toHaveLength(1);
    expect(parseRecent(null)).toEqual([]);
  });
});
