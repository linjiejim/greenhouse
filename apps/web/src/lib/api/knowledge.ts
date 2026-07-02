/**
 * Team Knowledge API client.
 */

import type {
  KnowledgeDoc,
  KnowledgeDocVersion,
  KnowledgeGenerateResult,
  KnowledgeSearchResult,
  KnowledgeShare,
} from '@greenhouse/types/api';
import { rpc } from './client';

export interface KnowledgeListParams {
  search?: string;
  space?: string;
  status?: 'draft' | 'published' | 'archived';
  /**
   * Scope the listing: 'team' = team docs, 'private' = the caller's own docs,
   * 'shared' = docs others shared with the caller. Omit for all of the above.
   */
  visibility?: 'team' | 'private' | 'shared';
  limit?: number;
  offset?: number;
}

export interface KnowledgeDocInput {
  title: string;
  slug?: string;
  content_markdown: string;
  content_json?: string;
  space?: string;
  visibility?: 'team' | 'private';
  status?: 'draft' | 'published' | 'archived';
  tags?: string[];
  summary?: string;
  questions?: string[];
  topics?: string[];
  change_reason?: string;
}

function buildQuery(params: object): Record<string, string> {
  const q: Record<string, string> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value !== undefined && value !== null && value !== '') q[key] = String(value);
  }
  return q;
}

export async function listKnowledgeDocs(params: KnowledgeListParams = {}): Promise<KnowledgeDoc[]> {
  const res = await rpc.api.knowledge.docs.$get({ query: buildQuery(params) });
  if (!res.ok) throw new Error('listKnowledgeDocs failed: ' + res.status);
  const data = await res.json();
  return data.docs;
}

export async function getKnowledgeDoc(slug: string): Promise<KnowledgeDoc> {
  const res = await rpc.api.knowledge.docs[':slug'].$get({ param: { slug: encodeURIComponent(slug) } });
  if (!res.ok) throw new Error('getKnowledgeDoc failed: ' + res.status);
  const data = await res.json();
  return data.doc;
}

export async function createKnowledgeDoc(input: KnowledgeDocInput): Promise<KnowledgeDoc> {
  const res = await rpc.api.knowledge.docs.$post({ json: input });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to create document');
  }
  const data = await res.json();
  return data.doc;
}

export async function updateKnowledgeDoc(id: number, input: Partial<KnowledgeDocInput>): Promise<KnowledgeDoc> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet);
  // the indirection passes the body while keeping param/response typing.
  const args = { param: { id: String(id) }, json: input };
  const res = await rpc.api.knowledge.docs[':id'].$put(args);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to update document');
  }
  const data = await res.json();
  return data.doc;
}

export async function archiveKnowledgeDoc(id: number): Promise<void> {
  const res = await rpc.api.knowledge.docs[':id'].$delete({ param: { id: String(id) } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to archive document');
  }
}

export async function listKnowledgeVersions(id: number): Promise<KnowledgeDocVersion[]> {
  const res = await rpc.api.knowledge.docs[':id'].versions.$get({ param: { id: String(id) } });
  if (!res.ok) throw new Error('listKnowledgeVersions failed: ' + res.status);
  const data = await res.json();
  return data.versions;
}

/** Roll a doc back to a prior version. The restore is recorded as a new version. */
export async function restoreKnowledgeVersion(id: number, version: number): Promise<KnowledgeDoc> {
  const res = await rpc.api.knowledge.docs[':id'].versions[':version'].restore.$post({
    param: { id: String(id), version: String(version) },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to restore version');
  }
  const data = await res.json();
  return data.doc;
}

// ─── Sharing (private docs) ─────────────────────────────

export async function listKnowledgeShares(id: number): Promise<KnowledgeShare[]> {
  const res = await rpc.api.knowledge.docs[':id'].shares.$get({ param: { id: String(id) } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to load shares');
  }
  const data = await res.json();
  return data.shares;
}

export async function shareKnowledgeDoc(
  id: number,
  input: { user_ids?: string[]; group_ids?: number[]; role: 'reader' | 'editor'; message?: string },
): Promise<void> {
  const args = { param: { id: String(id) }, json: input };
  const res = await rpc.api.knowledge.docs[':id'].shares.$post(args);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to share document');
  }
}

/** Revoke a grant. `target` is a user id or 'group:<id>'. */
export async function revokeKnowledgeShare(id: number, target: string): Promise<void> {
  // encodeURIComponent matches the previous hand-built URL byte-for-byte
  // (the server decodeURIComponent()s the param on top of router decoding).
  const res = await rpc.api.knowledge.docs[':id'].shares[':target'].$delete({
    param: { id: String(id), target: encodeURIComponent(target) },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to revoke share');
  }
}

/**
 * Bulk-rename a team space (KB category) and every nested descendant
 * (`eng` → `engineering` also moves `eng/backend`). Returns the number of
 * documents moved.
 */
export async function renameKnowledgeSpace(from: string, to: string): Promise<number> {
  const res = await rpc.api.knowledge.spaces.rename.$post({ json: { from, to } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to rename space');
  }
  const data = await res.json();
  return 'count' in data ? data.count : 0;
}

export async function searchKnowledgeDocs(query: string, limit = 10): Promise<KnowledgeSearchResult[]> {
  const res = await rpc.api.knowledge.search.$get({ query: buildQuery({ q: query, limit }) });
  if (!res.ok) throw new Error('searchKnowledgeDocs failed: ' + res.status);
  const data = await res.json();
  return data.results;
}

export async function generateKnowledgeDraft(prompt: string): Promise<KnowledgeGenerateResult> {
  const res = await rpc.api.knowledge.docs.generate.$post({ json: { prompt } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to generate draft');
  }
  const data = await res.json();
  return data.draft;
}

export async function rewriteKnowledgeDoc(
  id: number,
  instruction: string,
): Promise<{ title?: string; content_markdown: string; change_summary: string }> {
  const args = { param: { id: String(id) }, json: { instruction } };
  const res = await rpc.api.knowledge.docs[':id'].ai.rewrite.$post(args);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to rewrite document');
  }
  const data = await res.json();
  return data.rewrite;
}

export async function enrichKnowledgeDoc(id: number): Promise<KnowledgeDoc> {
  const res = await rpc.api.knowledge.docs[':id'].enrich.$post({ param: { id: String(id) } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to enrich document');
  }
  const data = await res.json();
  // Server types `doc` as nullable (re-read after the enrichment update can
  // miss); surface that instead of returning null as a KnowledgeDoc.
  if (!data.doc) throw new Error('Failed to enrich document');
  return data.doc;
}
