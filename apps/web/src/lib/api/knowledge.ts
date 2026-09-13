/**
 * Team Knowledge API client.
 */

import type {
  KnowledgeDoc,
  KnowledgeDocVersion,
  KnowledgeShare,
  KnowledgeBacklink,
  KnowledgeComment,
  KnowledgeConflict,
  KnowledgeEditor,
  KnowledgeTemplateSummary,
  KnowledgeSearchHit,
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
  /** kb drive folder to move the doc into (null = root). */
  folder_id?: number | null;
  is_template?: boolean;
  /** The updated_at the editor loaded — set on save so the server can flag LWW conflicts. */
  base_updated_at?: string;
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

/** Server-side page size ceiling for the doc list (`Math.min(limit, 100)`). */
const DOC_PAGE_SIZE = 100;
/** Refuse to spin forever if the server ever stops honouring `offset`. */
const MAX_DOC_PAGES = 50;

/**
 * Every doc in one visibility, paged.
 *
 * The list endpoint caps at 100 per request and the sidebar used to call it with
 * no limit at all — so a library past 50 team docs silently lost the tail, which
 * is invisible until someone asks where their document went. Paging must be
 * per-visibility: the unfiltered branch runs three queries and applies the same
 * offset to each, so an offset over the merged result is meaningless.
 */
export async function listAllKnowledgeDocs(
  params: KnowledgeListParams & { visibility: NonNullable<KnowledgeListParams['visibility']> },
): Promise<KnowledgeDoc[]> {
  const all: KnowledgeDoc[] = [];
  for (let page = 0; page < MAX_DOC_PAGES; page++) {
    const batch = await listKnowledgeDocs({ ...params, limit: DOC_PAGE_SIZE, offset: page * DOC_PAGE_SIZE });
    all.push(...batch);
    if (batch.length < DOC_PAGE_SIZE) break;
  }
  return all;
}

/**
 * Persist a manual sibling order for the knowledge sidebar tree. `ids` is the
 * full ordered list of that parent's children of one kind; the server refuses
 * anything that isn't already a sibling, so this can never move a node.
 */
export async function reorderKnowledgeTree(
  kind: 'doc' | 'folder',
  parentId: number | null,
  ids: number[],
): Promise<void> {
  const args = { json: { kind, parent_id: parentId, ids } };
  const res = await rpc.api.knowledge.tree.reorder.$post(args);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `reorderKnowledgeTree failed: ${res.status}`);
  }
}

/**
 * Unified knowledge search. `scope` selects the channels; omit it for the legacy
 * team + own-private behaviour. `all` adds the shared-with-me channel.
 */
export async function searchKnowledge(
  query: string,
  scope?: 'team' | 'personal' | 'shared' | 'all',
  limit = 20,
): Promise<{ results: KnowledgeSearchHit[]; query: string }> {
  const q: Record<string, string> = { q: query, limit: String(limit) };
  if (scope) q.scope = scope;
  const res = await rpc.api.knowledge.search.$get({ query: q });
  if (!res.ok) throw new Error('searchKnowledge failed: ' + res.status);
  const data = await res.json();
  return { results: data.results as KnowledgeSearchHit[], query: data.query };
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

export async function updateKnowledgeDoc(
  id: number,
  input: Partial<KnowledgeDocInput>,
): Promise<{ doc: KnowledgeDoc; conflict?: KnowledgeConflict }> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet);
  // the indirection passes the body while keeping param/response typing.
  const args = { param: { id: String(id) }, json: input };
  const res = await rpc.api.knowledge.docs[':id'].$put(args);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to update document');
  }
  const data = await res.json();
  return { doc: data.doc, conflict: 'conflict' in data ? (data.conflict as KnowledgeConflict) : undefined };
}

/** Fetch a doc by numeric id (backs the canonical #/knowledge/doc/<id>-<slug> deeplink). */
export async function getKnowledgeDocById(id: number): Promise<KnowledgeDoc> {
  const res = await rpc.api.knowledge.docs.id[':id'].$get({ param: { id: String(id) } });
  if (!res.ok) throw new Error('getKnowledgeDocById failed: ' + res.status);
  const data = await res.json();
  return data.doc;
}

/** Docs that link TO this doc (access-filtered). */
export async function listKnowledgeBacklinks(id: number): Promise<KnowledgeBacklink[]> {
  const res = await rpc.api.knowledge.docs[':id'].backlinks.$get({ param: { id: String(id) } });
  if (!res.ok) throw new Error('listKnowledgeBacklinks failed: ' + res.status);
  const data = await res.json();
  return data.backlinks;
}

// ─── Comments ───────────────────────────────────────────

export async function listKnowledgeComments(id: number): Promise<KnowledgeComment[]> {
  const res = await rpc.api.knowledge.docs[':id'].comments.$get({ param: { id: String(id) } });
  if (!res.ok) throw new Error('listKnowledgeComments failed: ' + res.status);
  const data = await res.json();
  return data.comments;
}

export async function addKnowledgeComment(id: number, content: string): Promise<KnowledgeComment> {
  const args = { param: { id: String(id) }, json: { content } };
  const res = await rpc.api.knowledge.docs[':id'].comments.$post(args);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to add comment');
  }
  const data = await res.json();
  return data.comment;
}

export async function deleteKnowledgeComment(commentId: number): Promise<void> {
  const res = await rpc.api.knowledge.comments[':cid'].$delete({ param: { cid: String(commentId) } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && 'error' in data && data.error) || 'Failed to delete comment');
  }
}

// ─── Templates & presence ───────────────────────────────

export async function listKnowledgeTemplates(): Promise<KnowledgeTemplateSummary[]> {
  const res = await rpc.api.knowledge.docs.templates.$get();
  if (!res.ok) throw new Error('listKnowledgeTemplates failed: ' + res.status);
  const data = await res.json();
  return data.templates;
}

/** Heartbeat that the caller is editing a doc; returns the OTHER current editors. */
export async function pingEditingPresence(id: number): Promise<KnowledgeEditor[]> {
  const res = await rpc.api.knowledge.docs[':id']['editing-presence'].$post({ param: { id: String(id) } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.editors;
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
