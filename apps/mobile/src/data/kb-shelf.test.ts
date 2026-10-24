import { describe, expect, it } from 'vitest';
import { parseShelf } from './kb-shelf';

describe('a saved knowledge shelf', () => {
  it('keeps the folders and documents it can read', () => {
    const shelf = parseShelf({
      folders: [{ id: 1, name: '运营', parent_id: null }, { id: 'x' }],
      docs: [{ id: 3, title: '周报' }, null],
    });
    // shelves saved before 3.0 hold numeric ids: they read as text
    expect(shelf?.folders.map((f) => f.id)).toEqual(['1']);
    expect(shelf?.docs.map((d) => d.id)).toEqual(['3']);
  });

  it('reads 3.0 text ids', () => {
    const shelf = parseShelf({
      folders: [{ id: 'fld_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', name: '运营', parent_id: '7' }],
      docs: [{ id: 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', title: '周报', folder_id: 'fld_01JB2Y8Z9QW3E4R5T6Y7V8H9P0' }],
    });
    expect(shelf?.folders[0]).toMatchObject({ id: 'fld_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', parent_id: '7' });
    expect(shelf?.docs[0]).toMatchObject({ id: 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', folder_id: 'fld_01JB2Y8Z9QW3E4R5T6Y7V8H9P0' });
  });

  it('is nothing when the copy is not a shelf', () => {
    expect(parseShelf(null)).toBeNull();
    expect(parseShelf({ folders: [] })).toBeNull();
    expect(parseShelf('x')).toBeNull();
  });
});
