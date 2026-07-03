/**
 * Knowledge base — read-only on mobile.
 */

import type { KnowledgeDoc } from '../shared/greenhouse-types';
import { api, apiJson } from './client';

export type { KnowledgeDoc };

export async function listDocs(opts?: {
  search?: string;
  space?: string;
  limit?: number;
  offset?: number;
}): Promise<KnowledgeDoc[]> {
  const q = new URLSearchParams();
  if (opts?.search) q.set('search', opts.search);
  if (opts?.space) q.set('space', opts.space);
  q.set('limit', String(opts?.limit ?? 50));
  q.set('offset', String(opts?.offset ?? 0));
  const data = await apiJson<{ docs: KnowledgeDoc[] }>(`/api/knowledge/docs?${q}`, { docs: [] });
  return data.docs ?? [];
}

export async function getDoc(slug: string): Promise<KnowledgeDoc | null> {
  try {
    const res = await api(`/api/knowledge/docs/${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { doc: KnowledgeDoc };
    return data.doc ?? null;
  } catch {
    return null;
  }
}

/** Parse the JSON-encoded tags column into a string list (best effort). */
export function docTags(doc: KnowledgeDoc): string[] {
  try {
    const v = JSON.parse(doc.tags || '[]');
    return Array.isArray(v) ? v.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}
