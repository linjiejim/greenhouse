import { describe, expect, it } from 'vitest';
import { parseShelf } from './kb-shelf';

describe('a saved knowledge shelf', () => {
  it('keeps the folders and documents it can read', () => {
    const shelf = parseShelf({
      folders: [{ id: 1, name: '运营', parent_id: null }, { id: 'x' }],
      docs: [{ id: 3, title: '周报' }, null],
    });
    expect(shelf?.folders.map((f) => f.id)).toEqual([1]);
    expect(shelf?.docs.map((d) => d.id)).toEqual([3]);
  });

  it('is nothing when the copy is not a shelf', () => {
    expect(parseShelf(null)).toBeNull();
    expect(parseShelf({ folders: [] })).toBeNull();
    expect(parseShelf('x')).toBeNull();
  });
});
