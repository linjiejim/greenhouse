/**
 * Every page of an offset-paginated list. React-free (./paging.test.ts). Pages are read one after
 * another until one comes back short; a page that brings nothing new (a route that ignores the
 * offset) or the page cap also ends it, so a list can never loop. All pages belong to the
 * identity they started on: a station or account switch between pages stops the read.
 */

import type { ApiResult } from '../api/client';

export async function collectPages<T extends { id: number }>(
  fetchPage: (offset: number, limit: number) => Promise<ApiResult<T[]>>,
  options: { pageSize: number; maxPages?: number; stillCurrent: () => boolean },
): Promise<ApiResult<T[]>> {
  const { pageSize, maxPages = 50, stillCurrent } = options;
  const items: T[] = [];
  const seen = new Set<number>();
  for (let page = 0; page < maxPages; page += 1) {
    if (!stillCurrent()) return { ok: false, status: 0, code: 'identity_changed', message: '' };
    const result = await fetchPage(page * pageSize, pageSize);
    if (!result.ok) return result;
    const fresh = result.data.filter((item) => !seen.has(item.id));
    for (const item of fresh) {
      seen.add(item.id);
      items.push(item);
    }
    if (result.data.length < pageSize || fresh.length === 0) break;
  }
  if (!stillCurrent()) return { ok: false, status: 0, code: 'identity_changed', message: '' };
  return { ok: true, data: items };
}
