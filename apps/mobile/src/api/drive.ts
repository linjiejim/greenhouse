/**
 * Files (档案库): the knowledge cabinet over `/api/drive` (scope `kb`, apps/api/src/routes/drive.ts)
 * — the team shelf and my own. Listing a folder level, search, the authenticated download URL
 * and the three-step upload (init → bytes to the presigned URL or the API → complete).
 * Every call answers an `ApiResult`, never throws.
 */

import type { DriveFile, DriveFolder, DriveUploadInit } from '../shared/greenhouse-types';
import { api, get, post, seg, toResult, networkMiss, type ApiMiss, type ApiResult } from './client';
import { getApiBase } from '../store/stations';

export type FilesShelf = 'team' | 'personal';

export const visibilityOfShelf = (shelf: FilesShelf): 'team' | 'private' => (shelf === 'personal' ? 'private' : 'team');

/** One level of a shelf: its folders and files (`folderId` null = the shelf's top). */
export async function listLevel(
  shelf: FilesShelf,
  folderId: number | null,
): Promise<ApiResult<{ folders: DriveFolder[]; files: DriveFile[] }>> {
  const scope = { scope: 'kb', visibility: visibilityOfShelf(shelf) };
  const [folders, files] = await Promise.all([
    get<{ folders: DriveFolder[] }>('/api/drive/folders', { ...scope, parent_id: folderId ?? undefined }),
    get<{ files: DriveFile[] }>('/api/drive/files', { ...scope, folder_id: folderId ?? undefined }),
  ]);
  if (!folders.ok) return folders;
  if (!files.ok) return files;
  return { ok: true, data: { folders: folders.data.folders, files: files.data.files } };
}

export interface CabinetHit {
  id: number;
  name: string;
  shelf: FilesShelf;
}

/** Name search over the team shelf and mine. */
export const searchCabinet = (q: string) =>
  get<{ folders: (CabinetHit & { parent_id: number | null })[]; files: (CabinetHit & { folder_id: number | null; size: number })[] }>(
    '/api/drive/search',
    { q, limit: 40 },
  );

export const breadcrumb = (folderId: number) =>
  get<{ folders: DriveFolder[] }>('/api/drive/breadcrumb', { folder_id: folderId });

/** The authenticated download address (302 to a signed URL, or the bytes). */
export const contentUrl = (fileId: number) => `${getApiBase()}/api/drive/files/${seg(String(fileId))}/content`;

export interface UploadSource {
  uri: string;
  name: string;
  size: number;
  type?: string | null;
}

/** Why an upload stopped without the server refusing it: the active station or account changed. */
export const IDENTITY_CHANGED = 'identity_changed';

const identityChanged = (): ApiMiss => ({ ok: false, status: 0, code: IDENTITY_CHANGED, message: '' });

/**
 * Upload one local file to a shelf / folder. `putBytes` sends the file at `uri` to a URL with
 * the given headers and answers the HTTP status (the app passes the native uploader, which
 * streams from disk).
 *
 * The whole upload belongs to the station + account it started on (`stillCurrent`, captured by
 * the caller before the first step): every step checks it right before it reads the active
 * station's address or token, and a change stops the upload — the bytes and the `complete`
 * never go to the station that became active meanwhile, and its token never rides along.
 */
export async function uploadFile(
  target: { shelf: FilesShelf; folderId: number | null },
  source: UploadSource,
  putBytes: (url: string, uri: string, headers: Record<string, string>) => Promise<number>,
  authHeader: () => string | null,
  stillCurrent: () => boolean,
): Promise<ApiResult<{ file: DriveFile }>> {
  if (!stillCurrent()) return identityChanged();
  const base = getApiBase();
  const init = await post<DriveUploadInit>('/api/drive/files/init', {
    scope: 'kb',
    visibility: visibilityOfShelf(target.shelf),
    ...(target.folderId ? { folder_id: target.folderId } : {}),
    name: source.name,
    size: source.size,
    ...(source.type ? { content_type: source.type } : {}),
  });
  if (!stillCurrent()) return identityChanged();
  if (!init.ok) return init;
  const contentType = source.type || 'application/octet-stream';
  try {
    if (init.data.mode === 'proxy') {
      const auth = authHeader();
      const status = await putBytes(`${base}${init.data.upload_url}`, source.uri, {
        'Content-Type': contentType,
        ...(auth ? { Authorization: auth } : {}),
      });
      if (!stillCurrent()) return identityChanged();
      if (status === 401) return { ok: false, status, code: 'unauthorized', message: '' };
      if (status < 200 || status >= 300) return { ok: false, status, code: 'upload_failed', message: '' };
      return { ok: true, data: { file: { id: init.data.file_id } as DriveFile } };
    }
    const status = await putBytes(init.data.upload_url, source.uri, { 'Content-Type': contentType });
    if (!stillCurrent()) return identityChanged();
    if (status < 200 || status >= 300) return { ok: false, status, code: 'upload_failed', message: '' };
    const done = await api(`/api/drive/files/${seg(String(init.data.file_id))}/complete`, { method: 'POST' });
    if (!stillCurrent()) return identityChanged();
    return await toResult<{ file: DriveFile }>(done);
  } catch (error) {
    return networkMiss(error);
  }
}

/** How a batch went: uploaded, refused or failed, and whether an identity change stopped it. */
export interface BatchOutcome {
  done: number;
  failed: number;
  /** Not attempted because the station or account changed. */
  skipped: number;
  stopped: boolean;
  error: string;
}

/**
 * Upload sources one after another, all bound to the identity captured before the first
 * (`stillCurrent`): once it changes, the rest are skipped rather than sent to the new station.
 */
export async function uploadBatch(
  target: { shelf: FilesShelf; folderId: number | null },
  sources: readonly UploadSource[],
  putBytes: (url: string, uri: string, headers: Record<string, string>) => Promise<number>,
  authHeader: () => string | null,
  stillCurrent: () => boolean,
): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { done: 0, failed: 0, skipped: 0, stopped: false, error: '' };
  for (const [index, source] of sources.entries()) {
    const result = await uploadFile(target, source, putBytes, authHeader, stillCurrent);
    if (result.ok) {
      outcome.done += 1;
      continue;
    }
    if (result.code === IDENTITY_CHANGED) {
      outcome.stopped = true;
      outcome.skipped = sources.length - index;
      break;
    }
    outcome.failed += 1;
    outcome.error ||= result.message;
  }
  return outcome;
}
