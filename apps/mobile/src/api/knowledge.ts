/**
 * Knowledge base — browse, edit and version history (/api/knowledge).
 * Access is server-resolved per doc (`doc.access`); the UI gates the edit
 * entry points with `canEditDoc` but the API re-checks every write.
 *
 * Doc addressing: the slug is the readable key (`/knowledge/<slug>`), the
 * numeric id is authoritative (slugs can be renamed). Entity links in chat
 * carry both (`#/knowledge/doc/<id>-<slug>`), so `resolveDoc` prefers the id
 * when one is known.
 */

import type { KnowledgeDoc, KnowledgeDocVersion } from '../shared/greenhouse-types';
import { api, apiJson } from './client';

export type { KnowledgeDoc, KnowledgeDocVersion };

/** List scope, mapped to the API's `visibility` filter ('all' sends none). */
export type KnowledgeScope = 'all' | 'team' | 'private' | 'shared';

/** Documents visible to the caller (server-side search). `null` = the request failed. */
export async function listDocs(opts?: {
  search?: string;
  space?: string;
  scope?: KnowledgeScope;
  limit?: number;
  offset?: number;
}): Promise<KnowledgeDoc[] | null> {
  const q = new URLSearchParams();
  if (opts?.search) q.set('search', opts.search);
  if (opts?.space) q.set('space', opts.space);
  if (opts?.scope && opts.scope !== 'all') q.set('visibility', opts.scope);
  q.set('limit', String(opts?.limit ?? 50));
  q.set('offset', String(opts?.offset ?? 0));
  try {
    const res = await api(`/api/knowledge/docs?${q}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { docs?: KnowledgeDoc[] };
    return data.docs ?? [];
  } catch {
    return null;
  }
}

/**
 * Why a doc couldn't be loaded: `'missing'` = gone, archived or no read access
 * (the API answers 404 for all three, so existence never leaks); `'failed'` =
 * the request itself failed (offline, 5xx) and is worth a retry.
 */
export type DocMiss = 'missing' | 'failed';

async function fetchDoc(path: string): Promise<KnowledgeDoc | DocMiss> {
  try {
    const res = await api(path);
    if (res.status === 404 || res.status === 403) return 'missing';
    if (!res.ok) return 'failed';
    const data = (await res.json()) as { doc?: KnowledgeDoc };
    return data.doc ?? 'missing';
  } catch {
    return 'failed';
  }
}

export function getDoc(slug: string): Promise<KnowledgeDoc | DocMiss> {
  return fetchDoc(`/api/knowledge/docs/${encodeURIComponent(slug)}`);
}

/** Canonical id-based read (backs the `#/knowledge/doc/<id>-<slug>` entity link). */
export function getDocById(id: number): Promise<KnowledgeDoc | DocMiss> {
  return fetchDoc(`/api/knowledge/docs/id/${id}`);
}

/**
 * Resolve a doc from route params: an explicit `id` wins; otherwise the slug,
 * and — if the slug misses and looks like an entity-link segment
 * (`<id>-<slug>`) — the id it starts with.
 */
export async function resolveDoc(ref: { slug?: string; id?: string | number }): Promise<KnowledgeDoc | DocMiss> {
  const id = Number(ref.id);
  if (ref.id != null && Number.isFinite(id) && id > 0) return getDocById(id);
  if (!ref.slug) return 'missing';
  const bySlug = await getDoc(ref.slug);
  if (bySlug !== 'missing') return bySlug;
  const m = /^(\d+)-./.exec(ref.slug);
  return m ? getDocById(Number(m[1])) : 'missing';
}

/** Someone else saved the doc after this editor loaded it (the save still went through — last write wins). */
export interface DocConflict {
  conflicted: true;
  updated_by: string | null;
  updated_at: string | null;
}

/**
 * Update title/content (the server records a version and re-derives the editor
 * JSON from the Markdown). Pass the `updated_at` the editor loaded as
 * `base_updated_at` so the server can flag a concurrent edit (`conflict`).
 * Returns the updated doc (+ conflict), or null on failure.
 */
export async function updateDoc(
  id: number,
  input: { title?: string; content_markdown?: string; base_updated_at?: string },
): Promise<{ doc: KnowledgeDoc; conflict?: DocConflict } | null> {
  try {
    const res = await api(`/api/knowledge/docs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { doc?: KnowledgeDoc; conflict?: DocConflict };
    return data.doc ? { doc: data.doc, conflict: data.conflict } : null;
  } catch {
    return null;
  }
}

/** Version history, newest first. `null` = the request failed. */
export async function listVersions(docId: number): Promise<KnowledgeDocVersion[] | null> {
  try {
    const res = await api(`/api/knowledge/docs/${docId}/versions`);
    if (!res.ok) return null;
    const data = (await res.json()) as { versions?: KnowledgeDocVersion[] };
    return data.versions ?? [];
  } catch {
    return null;
  }
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

/**
 * Best-effort user-id → nickname directory for author labels. The knowledge
 * API returns bare user ids (`updated_by`, `changed_by`) and has no directory
 * of its own, so this borrows the internal-user list behind the project
 * pickers; when the caller can't read it, names are simply omitted.
 */
export async function listUserNames(): Promise<Map<string, string>> {
  const data = await apiJson<{ users?: { id: string; nickname: string }[] }>('/api/projects/meta/users', {});
  return new Map((data.users ?? []).map((u) => [u.id, u.nickname]));
}

/** Whether the current viewer may edit/restore (server-resolved role on the doc). */
export function canEditDoc(doc: KnowledgeDoc): boolean {
  return doc.access === 'owner' || doc.access === 'editor';
}

/** Parse the JSON-encoded tags column into a string list (best effort). */
export function docTags(doc: KnowledgeDoc): string[] {
  try {
    const v: unknown = JSON.parse(doc.tags || '[]');
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}
