/**
 * Select options keep their ids through edits: records store option ids, so
 * removing, reordering or renaming a line must never hand one option's id to
 * another (the old one-per-line textarea assigned ids by line position).
 */

import { describe, expect, it } from 'vitest';
import { moveRow, newOptionRow, optionRows, optionsFromRows } from './option-list';

const stored = [
  { id: 'todo', label: 'To do', color: 'slot-1' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done' },
];

describe('optionsFromRows', () => {
  it('keeps ids (and colours) when a line is removed', () => {
    const rows = optionRows(stored).slice(1);
    expect(optionsFromRows(rows, stored)).toEqual([
      { id: 'doing', label: 'Doing' },
      { id: 'done', label: 'Done' },
    ]);
  });

  it('moves ids with their rows when reordered, and keeps them through a rename', () => {
    let rows = moveRow(optionRows(stored), 2, -1);
    rows = rows.map((row) => (row.option?.id === 'todo' ? { ...row, label: 'Backlog' } : row));
    expect(optionsFromRows(rows, stored)).toEqual([
      { id: 'todo', label: 'Backlog', color: 'slot-1' },
      { id: 'done', label: 'Done' },
      { id: 'doing', label: 'Doing' },
    ]);
  });

  it('never gives a new option the id of a removed one, and skips blank rows', () => {
    const removed = [{ id: 'blocked-1', label: 'Blocked' }, ...stored];
    const rows = [...optionRows(stored), newOptionRow('Blocked'), newOptionRow('  '), newOptionRow('Blocked')];
    const options = optionsFromRows(rows, removed);
    expect(options.map((option) => option.id)).toEqual(['todo', 'doing', 'done', 'blocked-2', 'blocked-3']);
    // A label without letters or digits still gets a valid id.
    expect(optionsFromRows([newOptionRow('进行中')], [])).toEqual([{ id: 'option-1', label: '进行中' }]);
  });

  it('leaves the order alone at the ends', () => {
    const rows = optionRows(stored);
    expect(moveRow(rows, 0, -1)).toEqual(rows);
    expect(moveRow(rows, 2, 1)).toEqual(rows);
  });
});
