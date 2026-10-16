import type { ApiResult } from '../api/client';

/** Refresh every page already visible, keeping the API's final cursor and metadata. */
export async function visiblePages<T extends { items: unknown[]; next_cursor: string | null }>(
  load: (cursor?: string) => Promise<ApiResult<T>>,
  count: number,
  merge: (before: T, after: T) => T = (before, after) => ({ ...after, items: [...before.items, ...after.items] }),
): Promise<ApiResult<T>> {
  let result = await load();
  for (let page = 1; page < count && result.ok && result.data.next_cursor; page++) {
    const next = await load(result.data.next_cursor);
    if (!next.ok) return next;
    result = { ok: true, data: merge(result.data, next.data) };
  }
  return result;
}
