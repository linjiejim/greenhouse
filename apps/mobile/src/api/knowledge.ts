/**
 * The knowledge base (`/api/knowledge`, apps/api/src/routes/knowledge.ts): documents of the team
 * shelf and my own (plus those shared with me), their folders (drive scope `kb`), search, one
 * document by id, and its comments. Every call answers an `ApiResult`, never throws.
 */

import type { DriveFolder, KbComment, KbDoc, KbSearchHit } from '../shared/greenhouse-types';
import { get, post, seg } from './client';

export type KbShelf = 'team' | 'personal';

const visibilityOf = (shelf: KbShelf) => (shelf === 'personal' ? 'private' : 'team');

/** Published documents of a shelf (the server caps a page at 100). */
export const listDocs = (shelf: KbShelf | 'shared') =>
  get<{ docs: KbDoc[] }>('/api/knowledge/docs', {
    visibility: shelf === 'shared' ? 'shared' : visibilityOf(shelf),
    limit: 100,
  });

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
