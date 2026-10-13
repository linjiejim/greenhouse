/** The knowledge base calls of the typed client (`client.knowledge`). */

import type { Page } from './common.js';
import type {
  CreateDocInput,
  CreateFolderInput,
  DocDiff,
  DocPresence,
  DocVersion,
  DocVersionDetail,
  KnowledgeComment,
  KnowledgeDoc,
  KnowledgeFile,
  KnowledgeFolder,
  KnowledgeItem,
  KnowledgeScope,
  KnowledgeSearchHit,
  KnowledgeShares,
  KnowledgeSpace,
  PresenceState,
  ReorderInput,
  ShareInput,
  UpdateDocInput,
  UpdateFileInput,
  UpdateFolderInput,
} from './knowledge.js';

type Query = Record<string, string | number | boolean | undefined>;

/** The client's own transport: bearer token, one refresh, the error envelope. */
export interface KnowledgeHttp {
  get<T>(path: string, query?: Query): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<void>;
  request<T>(method: string, path: string, body?: unknown, init?: { query?: Query; raw?: BodyInit }): Promise<T>;
  download(path: string): Promise<{ filename: string; text: string }>;
  downloadBlob(path: string, query?: Query): Promise<{ filename: string; blob: Blob }>;
}

const at = (kind: 'folders' | 'docs' | 'files', id: string, rest = '') =>
  `/api/knowledge/${kind}/${encodeURIComponent(id)}${rest}`;

export function knowledgeApi(http: KnowledgeHttp) {
  return {
    /** Full text over titles and content I may read, best first, with snippets. */
    search: (query: { q: string; space?: KnowledgeScope; folder_id?: string; limit?: number }) =>
      http.get<{ items: KnowledgeSearchHit[] }>('/api/knowledge/search', query),
    /** What was archived in a space, topmost first: opening an archived folder shows the rest. */
    archived: (space: KnowledgeSpace) => http.get<{ items: KnowledgeItem[] }>('/api/knowledge/archived', { space }),
    /** Hand order for some items of one folder (or the root of a space). */
    reorder: (input: ReorderInput) => http.post<void>('/api/knowledge/reorder', input),
    /** A whole space as a ZIP of Markdown files and its files. */
    exportSpace: (space: KnowledgeSpace) => http.downloadBlob('/api/knowledge/export', { space }),

    folders: {
      /** The root of a space, or the folders and docs others shared with me. */
      roots: (space: KnowledgeScope) => http.get<{ items: KnowledgeItem[] }>('/api/knowledge/folders', { space }),
      get: (id: string) => http.get<KnowledgeFolder>(at('folders', id)),
      create: (input: CreateFolderInput) => http.post<KnowledgeFolder>('/api/knowledge/folders', input),
      /** Rename, or move (into a folder, or to a space root with `folder_id: null`). */
      update: (id: string, input: UpdateFolderInput) => http.patch<KnowledgeFolder>(at('folders', id), input),
      /** Archives it with everything in it. */
      archive: (id: string) => http.del(at('folders', id)),
      restore: (id: string) => http.post<KnowledgeFolder>(at('folders', id, '/restore')),
      shares: (id: string) => http.get<KnowledgeShares>(at('folders', id, '/share')),
      share: (id: string, input: ShareInput) => http.put<KnowledgeShares>(at('folders', id, '/share'), input),
      /** The folder as a ZIP of Markdown files and its files. */
      export: (id: string) => http.downloadBlob(at('folders', id, '/export')),
    },

    docs: {
      /** Recently updated docs I can read; `template: true` lists templates. */
      list: (query: { space?: KnowledgeScope; template?: boolean; cursor?: string; limit?: number } = {}) =>
        http.get<Page<KnowledgeItem>>('/api/knowledge/docs', {
          ...query,
          template: query.template === undefined ? undefined : String(query.template),
        }),
      get: (id: string) => http.get<KnowledgeDoc>(at('docs', id)),
      create: (input: CreateDocInput) => http.post<KnowledgeDoc>('/api/knowledge/docs', input),
      /** A save sends the version it started from; a newer one answers 409 `stale_version`. */
      update: (id: string, input: UpdateDocInput) => http.patch<KnowledgeDoc>(at('docs', id), input),
      archive: (id: string) => http.del(at('docs', id)),
      restore: (id: string) => http.post<KnowledgeDoc>(at('docs', id, '/restore')),
      versions: (id: string, query: { cursor?: string; limit?: number } = {}) =>
        http.get<Page<DocVersion>>(at('docs', id, '/versions'), query),
      version: (id: string, version: number) => http.get<DocVersionDetail>(at('docs', id, `/versions/${version}`)),
      /** Writes a new version with that one's title and content; `current` is the doc's version now. */
      restoreVersion: (id: string, version: number, current: number) =>
        http.post<KnowledgeDoc>(at('docs', id, `/versions/${version}/restore`), { version: current }),
      diff: (id: string, query: { from?: number; to?: number; mode?: 'line' | 'word' } = {}) =>
        http.get<DocDiff>(at('docs', id, '/diff'), query),
      backlinks: (id: string) => http.get<{ items: KnowledgeItem[] }>(at('docs', id, '/backlinks')),
      comments: (id: string, query: { cursor?: string; limit?: number } = {}) =>
        http.get<Page<KnowledgeComment>>(at('docs', id, '/comments'), query),
      comment: (id: string, body: string) => http.post<KnowledgeComment>(at('docs', id, '/comments'), { body }),
      editComment: (id: string, commentId: string, body: string) =>
        http.patch<KnowledgeComment>(at('docs', id, `/comments/${encodeURIComponent(commentId)}`), { body }),
      removeComment: (id: string, commentId: string) =>
        http.del(at('docs', id, `/comments/${encodeURIComponent(commentId)}`)),
      shares: (id: string) => http.get<KnowledgeShares>(at('docs', id, '/share')),
      share: (id: string, input: ShareInput) => http.put<KnowledgeShares>(at('docs', id, '/share'), input),
      presence: (id: string) => http.get<{ items: DocPresence[] }>(at('docs', id, '/presence')),
      /** I have it open (`viewing`) or am changing it (`editing`): every 20 seconds or so. */
      beat: (id: string, state: PresenceState) =>
        http.put<{ items: DocPresence[] }>(at('docs', id, '/presence'), { state }),
      leave: (id: string) => http.del(at('docs', id, '/presence')),
      /** The doc as a Markdown file. */
      async export(id: string): Promise<{ filename: string; markdown: string }> {
        const file = await http.download(at('docs', id, '/export'));
        return { filename: file.filename, markdown: file.text };
      },
    },

    files: {
      /** Into a folder or the root of a space, or for a doc (a picture pasted into it). */
      upload(
        file: Blob & { name?: string },
        fields: { folder_id?: string; space?: KnowledgeSpace; doc_id?: string },
      ): Promise<KnowledgeFile> {
        const form = new FormData();
        form.set('file', file, file.name ?? 'file');
        for (const [key, value] of Object.entries(fields)) if (value) form.set(key, value);
        return http.request<KnowledgeFile>('POST', '/api/knowledge/files', undefined, { raw: form });
      },
      get: (id: string) => http.get<KnowledgeFile>(at('files', id)),
      update: (id: string, input: UpdateFileInput) => http.patch<KnowledgeFile>(at('files', id), input),
      archive: (id: string) => http.del(at('files', id)),
      restore: (id: string) => http.post<KnowledgeFile>(at('files', id, '/restore')),
    },
  };
}
