import { describe, expect, it } from 'vitest';
import type { KbDoc } from '../shared/greenhouse-types';
import { docMiss, dropped, parseRecent, parseSaved, RECENT_MAX, toSaved, withOpened } from './recent-docs';

describe('recently opened documents', () => {
  it('moves a reopened document to the top and caps the list', () => {
    let list = withOpened([], { id: '1', title: 'A' }, 1);
    list = withOpened(list, { id: 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', title: 'B' }, 2);
    list = withOpened(list, { id: '1', title: 'A2' }, 3);
    expect(list.map((e) => [e.id, e.title])).toEqual([
      ['1', 'A2'],
      ['doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', 'B'],
    ]);
    let long = list;
    for (let i = 10; i < 10 + RECENT_MAX; i++) long = withOpened(long, { id: String(i), title: `D${i}` }, i);
    expect(long).toHaveLength(RECENT_MAX);
    expect(dropped(list, long).sort()).toEqual(['1', 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0']);
  });

  it('reads back what it wrote and nothing else', () => {
    const doc = {
      id: 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0',
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
    expect(parseSaved(JSON.parse(JSON.stringify(saved)), 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0')).toEqual(saved);
    expect(parseSaved(saved, '8')).toBeNull();
    expect(parseRecent([{ id: 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', title: 't', openedAt: 1 }, { id: 'x' }])).toHaveLength(1);
    expect(parseRecent(null)).toEqual([]);
  });

  it('reads copies saved before 3.0, whose ids were numbers, as text ids', () => {
    expect(parseRecent([{ id: 1, title: 't', openedAt: 1 }])).toEqual([{ id: '1', title: 't', openedAt: 1 }]);
    const old = { v: 1, doc: { id: 7, slug: 's', title: 'T', content_markdown: '', visibility: 'team', updated_at: 'x', folder_id: 3 }, savedAt: 5 };
    expect(parseSaved(old, '7')?.doc).toMatchObject({ id: '7', folder_id: '3' });
    expect(parseSaved(old, '8')).toBeNull();
    expect(parseRecent(null)).toEqual([]);
  });
});

describe('a document the station would not give back', () => {
  it('loses its saved copy when access was revoked or it is gone', () => {
    expect(docMiss(403)).toBe('gone');
    expect(docMiss(404)).toBe('gone');
    expect(docMiss(410)).toBe('gone');
  });

  it('reads from the saved copy only when the station could not be reached', () => {
    expect(docMiss(0)).toBe('unreachable');
    expect(docMiss(502)).toBe('unreachable');
    expect(docMiss(503)).toBe('unreachable');
    expect(docMiss(504)).toBe('unreachable');
  });

  it('shows an error, not the copy, for any other answer', () => {
    for (const status of [400, 401, 409, 429, 500]) expect(docMiss(status)).toBe('failed');
  });
});
