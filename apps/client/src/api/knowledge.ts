/**
 * The knowledge base (`/api/knowledge`, apps/api/src/routes/knowledge.ts): documents of the team
 * shelf and my own (plus those shared with me), their folders (drive scope `kb`), search and one
 * document by id. Every call answers an `ApiResult`, never throws.
 */

import type { DriveFolder, KbDoc, KbSearchHit, KbShare } from '../shared/greenhouse-types';
import { collectPages } from '../data/paging';
import { del, get, post, put, seg, type ApiResult } from './client';

export type KbShelf = 'team' | 'personal';

const visibilityOf = (shelf: KbShelf) => (shelf === 'personal' ? 'private' : 'team');

/** The server caps a page of documents at 100. */
const DOC_PAGE = 100;

/**
 * Every document of a shelf. The team shelf and mine are paginated by `offset` and read page by
 * page (../data/paging.ts); documents shared with me come in one answer (that route ignores the
 * offset). All pages belong to the identity `stillCurrent` was captured on.
 */
export async function listDocs(shelf: KbShelf | 'shared', stillCurrent: () => boolean): Promise<ApiResult<{ docs: KbDoc[] }>> {
  if (shelf === 'shared') return get<{ docs: KbDoc[] }>('/api/knowledge/docs', { visibility: 'shared' });
  const all = await collectPages<KbDoc>(
    async (offset, limit) => {
      const page = await get<{ docs: KbDoc[] }>('/api/knowledge/docs', { visibility: visibilityOf(shelf), limit, offset });
      return page.ok ? { ok: true, data: page.data.docs } : page;
    },
    { pageSize: DOC_PAGE, stillCurrent },
  );
  return all.ok ? { ok: true, data: { docs: all.data } } : all;
}

/** Every folder of a shelf, flat (the client builds the tree). */
export const listKbFolders = (shelf: KbShelf) =>
  get<{ folders: DriveFolder[] }>('/api/drive/folders', { scope: 'kb', visibility: visibilityOf(shelf), parent_id: 'all' });

export const getDoc = (id: string) => get<{ doc: KbDoc }>(`/api/knowledge/docs/id/${seg(String(id))}`);

/** A document by its slug (a link without an id); the same read check as by id. */
export const getDocBySlug = (slug: string) => get<{ doc: KbDoc }>(`/api/knowledge/docs/${seg(slug)}`);

export const searchDocs = (q: string) =>
  get<{ results: KbSearchHit[]; query: string }>('/api/knowledge/search', { q, scope: 'all', limit: 30 });

/** A new document on a shelf, in a folder or at the top. */
export const createDoc = (input: { title: string; content: string; shelf: KbShelf; folderId: string | null }) =>
  post<{ doc: KbDoc }>('/api/knowledge/docs', {
    title: input.title,
    content_markdown: input.content,
    visibility: visibilityOf(input.shelf),
    ...(input.folderId ? { folder_id: input.folderId } : {}),
  });

/** Rename and / or move a document (`folderId` null = the shelf's top). */
export const updateDoc = (id: string, change: { title?: string; folderId?: string | null }) =>
  put<{ doc: KbDoc }>(`/api/knowledge/docs/${seg(String(id))}`, {
    ...(change.title !== undefined ? { title: change.title } : {}),
    ...(change.folderId !== undefined ? { folder_id: change.folderId } : {}),
  });

/** Archive a document (the owner's, or any team document). */
export const deleteDoc = (id: string) => del<{ success: true }>(`/api/knowledge/docs/${seg(String(id))}`);

/**
 * Who a private document is shared with (`/api/knowledge/docs/:id/shares`); only its owner may
 * read or change this (403 otherwise), and team documents take no grants (400). Sharing again
 * with someone changes their role.
 */
export const listDocShares = (id: string) => get<{ shares: KbShare[] }>(`/api/knowledge/docs/${seg(String(id))}/shares`);

export const shareDoc = (id: string, userIds: readonly string[], role: KbShare['role']) =>
  post<{ success: true }>(`/api/knowledge/docs/${seg(String(id))}/shares`, { user_ids: userIds, role });

export const unshareDoc = (id: string, target: string) =>
  del<{ success: true }>(`/api/knowledge/docs/${seg(String(id))}/shares/${seg(target)}`);

/**
 * Active members one may share with, myself left out (`/api/sessions/shareable-users`). The
 * station hides it (404) when conversation sharing is off.
 */
export const listShareableUsers = () =>
  get<{ users: { id: string; nickname: string; email?: string }[] }>('/api/sessions/shareable-users');
