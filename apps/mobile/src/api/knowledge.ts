/**
 * The knowledge base (`/api/knowledge`, apps/api/src/routes/knowledge.ts): documents of the team
 * shelf and my own (plus those shared with me), their folders (drive scope `kb`), search, one
 * document by id, and its comments. Every call answers an `ApiResult`, never throws.
 */

import type { DriveFolder, KbComment, KbDoc, KbSearchHit } from '../shared/greenhouse-types';
import { collectPages } from '../data/paging';
import { get, post, seg, type ApiResult } from './client';

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

export const getDoc = (id: number) => get<{ doc: KbDoc }>(`/api/knowledge/docs/id/${seg(String(id))}`);

export const searchDocs = (q: string) =>
  get<{ results: KbSearchHit[]; query: string }>('/api/knowledge/search', { q, scope: 'all', limit: 30 });

export const listComments = (docId: number) =>
  get<{ comments: KbComment[] }>(`/api/knowledge/docs/${seg(String(docId))}/comments`);

export const addComment = (docId: number, content: string) =>
  post<{ comment: KbComment }>(`/api/knowledge/docs/${seg(String(docId))}/comments`, { content });
