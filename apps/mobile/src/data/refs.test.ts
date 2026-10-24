import { describe, expect, it } from 'vitest';
import { parseResolved } from './refs';

describe('resolved link titles', () => {
  it('reads titles, hidden objects and file details', () => {
    const map = parseResolved({
      items: [
        { url: 'u1', type: 'doc', id: 12, title: '周报' },
        { url: 'u2', type: 'task', id: '9', title: null },
        { url: 'u3', type: 'file', id: 'f1', title: 'a.pdf', meta: { size: 2048, contentType: 'application/pdf' } },
        { type: 'doc' },
        null,
      ],
    });
    expect(map.get('u1')).toEqual({ type: 'doc', id: '12', title: '周报' });
    expect(map.get('u2')?.title).toBeNull();
    expect(map.get('u3')).toMatchObject({ size: 2048, contentType: 'application/pdf' });
    expect(map.size).toBe(3);
  });

  it('is empty for anything else', () => {
    expect(parseResolved(null).size).toBe(0);
    expect(parseResolved({ items: 'x' }).size).toBe(0);
  });
});
