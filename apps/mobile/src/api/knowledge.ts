import type {
  Page,
  KnowledgeItem,
  KnowledgeFolder,
  KnowledgeDoc,
  KnowledgeFile,
  KnowledgeSearchHit,
  KnowledgeScope,
  DocVersion,
  DocVersionDetail,
  KnowledgeComment,
  KnowledgeShares,
  DocPresence,
} from '../shared/contract';
import { get, patch, post, put, del, seg } from './client';
export const roots = (space: KnowledgeScope, cursor?: string) =>
  get<Page<KnowledgeItem>>('/api/knowledge/folders', { space, cursor });
export const folder = (id: string, cursor?: string) =>
  get<KnowledgeFolder>(`/api/knowledge/folders/${seg(id)}`, { cursor });
export const searchKnowledge = (q: string, space: KnowledgeScope, folder_id?: string) =>
  get<{ items: KnowledgeSearchHit[] }>('/api/knowledge/search', { q, space, folder_id });
export const doc = (id: string) => get<KnowledgeDoc>(`/api/knowledge/docs/${seg(id)}`);
export const saveDoc = (id: string, version: number, title: string, content?: string) =>
  patch<KnowledgeDoc>(`/api/knowledge/docs/${seg(id)}`, {
    version,
    title,
    ...(content === undefined ? {} : { content }),
  });
export const versions = (id: string, cursor?: string) =>
  get<Page<DocVersion>>(`/api/knowledge/docs/${seg(id)}/versions`, { cursor });
export const versionDetail = (id: string, version: number) =>
  get<DocVersionDetail>(`/api/knowledge/docs/${seg(id)}/versions/${version}`);
export const comments = (id: string, cursor?: string) =>
  get<Page<KnowledgeComment>>(`/api/knowledge/docs/${seg(id)}/comments`, { cursor });
export const addComment = (id: string, body: string) =>
  post<KnowledgeComment>(`/api/knowledge/docs/${seg(id)}/comments`, { body });
export const shares = (kind: 'docs' | 'folders', id: string) =>
  get<KnowledgeShares>(`/api/knowledge/${kind}/${seg(id)}/share`);
export const knowledgeFile = (id: string) => get<KnowledgeFile>(`/api/knowledge/files/${seg(id)}`);
export const presence = (id: string) => get<{ items: DocPresence[] }>(`/api/knowledge/docs/${seg(id)}/presence`);
export const heartbeat = (id: string, editing = false) =>
  put(`/api/knowledge/docs/${seg(id)}/presence`, { state: editing ? 'editing' : 'viewing' });
export const leaveDoc = (id: string) => del(`/api/knowledge/docs/${seg(id)}/presence`);
