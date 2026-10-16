import { expect, it } from 'vitest';
import type { AppSpec } from '@greenhouse/contract';
import { pageDiff, move } from '../model';
it('reports added, removed, changed pages and permission changes before publishing', () => {
  const before: AppSpec = {
    pages: [
      { id: 'a', name: 'A', cards: [] },
      { id: 'b', name: 'B', cards: [] },
    ],
    roles: [],
  };
  const after: AppSpec = {
    pages: [
      { id: 'a', name: 'Changed', cards: [] },
      { id: 'c', name: 'C', cards: [] },
    ],
    roles: [{ id: 'staff', name: 'Staff', rules: { tables: {} } }],
  };
  expect(pageDiff(before, after)).toEqual({ added: 1, removed: 1, changed: 1, permissions: true });
  expect(move(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
  expect(move(['a'], 0, -1)).toEqual(['a']);
});
