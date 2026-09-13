/**
 * Global search API client.
 */

import type { GlobalSearchResponse, SearchGroup, SearchKind } from '@greenhouse/types/search';
import { rpc } from './client';

export async function globalSearch(query: string, kind: SearchKind | null): Promise<GlobalSearchResponse> {
  const params: Record<string, string> = { q: query };
  if (kind) params.kind = kind;
  const res = await rpc.api.search.$get({ query: params });
  if (!res.ok) throw new Error('globalSearch failed: ' + res.status);
  const data = await res.json();
  // The server's discriminated union widens through the wire; the shape is
  // pinned by `@greenhouse/types/search`, which both sides import.
  return { query: data.query, groups: (data.groups ?? []) as SearchGroup[] };
}
