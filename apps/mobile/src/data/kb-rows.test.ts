import { describe, expect, it } from 'vitest';
import type { DriveFolder, KbDoc } from '../shared/greenhouse-types';
import { shelfRows } from './kb-rows';

const recent = [
  { id: 7, title: 'Brand Voice', openedAt: 2 },
  { id: 3, title: 'Handbook', openedAt: 1 },
];
const level = {
  folders: [{ id: 1, name: 'Marketing', parent_id: null } as DriveFolder],
  docs: [{ id: 9, title: 'FAQ', updated_at: '2026-06-22' } as KbDoc],
};
const base = { atTop: true, recent, level, loading: false, titles: { recent: 'Recent', shelf: 'Team' }, docSubtitle: () => undefined };
const kinds = (rows: { type: string; key: string }[]) => rows.map((row) => row.key);

describe('the rows of a knowledge shelf', () => {
  it('lists recently opened documents above the shelf', () => {
    expect(kinds(shelfRows(base))).toEqual(['h-recent', 'recent-7', 'recent-3', 'h-shelf', 'f-1', 'd-9']);
  });

  it('still lists the recent, saved documents on a cold offline launch when the shelf failed', () => {
    const rows = shelfRows({ ...base, level: null, loading: false });
    expect(kinds(rows)).toEqual(['h-recent', 'recent-7', 'recent-3', 'failed']);
  });

  it('shows them while the shelf is still loading', () => {
    expect(kinds(shelfRows({ ...base, level: null, loading: true }))).toEqual(['h-recent', 'recent-7', 'recent-3', 'loading']);
  });

  it('leaves the screen’s empty state to speak when there is nothing recent', () => {
    expect(shelfRows({ ...base, recent: [], level: null })).toEqual([]);
  });

  it('lists no recent documents inside a folder', () => {
    expect(kinds(shelfRows({ ...base, atTop: false }))).toEqual(['f-1', 'd-9']);
  });
});
