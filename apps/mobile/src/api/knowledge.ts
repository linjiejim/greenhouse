/**
 * Knowledge base — browse, edit and version history (/api/knowledge).
 * Access is server-resolved per doc (`doc.access`); the UI gates the edit
 * entry points with `canEditDoc` but the API re-checks every write.
 */

import type { KnowledgeDoc, KnowledgeDocVersion } from '../shared/greenhouse-types';
import { api, apiJson } from './client';

export type { KnowledgeDoc, KnowledgeDocVersion };

/** List scope, mapped to the API's `visibility` filter ('all' sends none). */
export type KnowledgeScope = 'all' | 'team' | 'private' | 'shared';

export async function listDocs(opts?: {
  search?: string;
  space?: string;
  scope?: KnowledgeScope;
  limit?: number;
  offset?: number;
}): Promise<KnowledgeDoc[]> {
  const q = new URLSearchParams();
  if (opts?.search) q.set('search', opts.search);
  if (opts?.space) q.set('space', opts.space);
  if (opts?.scope && opts.scope !== 'all') q.set('visibility', opts.scope);
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

/**
 * Update title/content (the server records a version and re-derives the editor
 * JSON from the Markdown). Returns the updated doc, or null on failure.
 */
export async function updateDoc(
  id: number,
  input: { title?: string; content_markdown?: string },
): Promise<KnowledgeDoc | null> {
  try {
    const res = await api(`/api/knowledge/docs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { doc: KnowledgeDoc };
    return data.doc ?? null;
  } catch {
    return null;
  }
}

/** Version history, newest first. */
export async function listVersions(docId: number): Promise<KnowledgeDocVersion[]> {
  const data = await apiJson<{ versions: KnowledgeDocVersion[] }>(`/api/knowledge/docs/${docId}/versions`, {
    versions: [],
  });
  return data.versions ?? [];
}

/** Roll back to a version. Non-destructive: the rollback is recorded as a new version. */
export async function restoreVersion(docId: number, version: number): Promise<KnowledgeDoc | null> {
  try {
    const res = await api(`/api/knowledge/docs/${docId}/versions/${version}/restore`, { method: 'POST' });
    if (!res.ok) return null;
    const data = (await res.json()) as { doc: KnowledgeDoc };
    return data.doc ?? null;
  } catch {
    return null;
  }
}

/** Whether the current viewer may edit/restore (server-resolved role on the doc). */
export function canEditDoc(doc: KnowledgeDoc): boolean {
  return doc.access === 'owner' || doc.access === 'editor';
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
