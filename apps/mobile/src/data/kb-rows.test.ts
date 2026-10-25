import { describe, expect, it } from 'vitest';
import type { DriveFolder, KbDoc } from '../shared/greenhouse-types';
import { recentRows, shelfRows } from './kb-rows';

const recent = [
  { id: '7', title: 'Brand Voice', openedAt: 2 },
  { id: '3', title: 'Handbook', openedAt: 1 },
];
const level = {
  folders: [{ id: '1', name: 'Marketing', parent_id: null } as DriveFolder],
  docs: [{ id: '9', title: 'FAQ', updated_at: '2026-06-22' } as KbDoc],
};

describe('the rows of the knowledge page', () => {
  it('lists the recently opened documents, newest first, each with when it was opened', () => {
    const rows = recentRows(recent, (entry) => `t${entry.openedAt}`);
    expect(rows).toEqual([
      { key: 'recent-7', type: 'doc', id: '7', title: 'Brand Voice', date: 't2', position: 'first' },
      { key: 'recent-3', type: 'doc', id: '3', title: 'Handbook', date: 't1', position: 'last' },
    ]);
  });

  it('puts a shelf level’s folders before its documents in one card, dates on the documents', () => {
    const rows = shelfRows(level, (doc) => doc.updated_at ?? '');
    expect(rows.map((row) => row.key)).toEqual(['f-1', 'd-9']);
    expect(rows[1]).toMatchObject({ title: 'FAQ', date: '2026-06-22', position: 'last' });
    expect(rows[0]).toMatchObject({ position: 'first' });
  });

  it('has no rows before the level has loaded, so the screen’s own state speaks', () => {
    expect(shelfRows(null, () => '')).toEqual([]);
    expect(recentRows([], () => '')).toEqual([]);
  });

  it('leaves out an unreadable date', () => {
    expect(shelfRows(level, () => '')[1]).not.toHaveProperty('date', '');
  });
});
