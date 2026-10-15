import { describe, expect, it } from 'vitest';
import { visiblePages } from './pages';

describe('visible pages on refresh', () => {
  it('keeps the pages a member already opened and their final cursor', async () => {
    const cursors: (string | undefined)[] = [];
    const result = await visiblePages(async (cursor) => {
      cursors.push(cursor);
      return { ok: true as const, data: { items: [cursor ?? 'first'], next_cursor: cursor ? 'third' : 'second' } };
    }, 2);
    expect(cursors).toEqual([undefined, 'second']);
    expect(result).toEqual({ ok: true, data: { items: ['first', 'second'], next_cursor: 'third' } });
  });
  it('reports a later page failure, so the screen can keep its previous complete list', async () => {
    const result = await visiblePages(
      async (cursor) =>
        cursor
          ? { ok: false as const, status: 0, code: 'network', message: '' }
          : { ok: true as const, data: { items: ['first'], next_cursor: 'second' } },
      2,
    );
    expect(result.ok).toBe(false);
  });
});
