import { describe, expect, it, vi } from 'vitest';
import { collectPages } from './paging';

const docs = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: from + i }));
/** A shelf of `total` documents served `limit` at a time from `offset`. */
const shelf = (total: number) =>
  vi.fn(async (offset: number, limit: number) => ({
    ok: true as const,
    data: docs(offset, Math.max(0, Math.min(limit, total - offset))),
  }));

describe('reading every page of a shelf', () => {
  it('follows the offset past the first 100 documents', async () => {
    const fetchPage = shelf(250);
    const result = await collectPages(fetchPage, { pageSize: 100, stillCurrent: () => true });
    expect(result.ok && result.data.length).toBe(250);
    expect(fetchPage.mock.calls.map(([offset]) => offset)).toEqual([0, 100, 200]);
  });

  it('asks for one more page when a shelf is an exact multiple of the page', async () => {
    const fetchPage = shelf(200);
    const result = await collectPages(fetchPage, { pageSize: 100, stillCurrent: () => true });
    expect(result.ok && result.data.length).toBe(200);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('stops when a page brings nothing new, so a route that ignores the offset cannot loop', async () => {
    const fetchPage = vi.fn(async () => ({ ok: true as const, data: docs(0, 100) }));
    const result = await collectPages(fetchPage, { pageSize: 100, stillCurrent: () => true });
    expect(result.ok && result.data.length).toBe(100);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('answers the first failure', async () => {
    let n = 0;
    const fetchPage = vi.fn(async () =>
      ++n === 2 ? { ok: false as const, status: 500, code: 'unavailable', message: '' } : { ok: true as const, data: docs(0, 100) },
    );
    expect(await collectPages(fetchPage, { pageSize: 100, stillCurrent: () => true })).toMatchObject({ ok: false, status: 500 });
  });

  it('stops at a station or account switch between pages', async () => {
    let current = true;
    const inner = shelf(300);
    const fetchPage = vi.fn(async (offset: number, limit: number) => {
      const page = await inner(offset, limit);
      current = false;
      return page;
    });
    const result = await collectPages(fetchPage, { pageSize: 100, stillCurrent: () => current });
    expect(result).toMatchObject({ ok: false, code: 'identity_changed' });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
