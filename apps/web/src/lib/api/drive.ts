/**
 * Drive (云盘) API client — folders + files for the CRM customer file cabinet
 * (and, later, the knowledge base).
 *
 * Stays on raw authFetch (not hc): uploads PUT raw bytes and downloads stream a
 * blob, which the hc JSON conventions don't cover. The JSON endpoints ride the
 * same authFetch for one cohesive module.
 */

import type { CabinetFileView, CabinetFolderView } from '@greenhouse/types/files';
import { authFetch } from '../auth';
import { downloadAuthenticatedFile } from '../file-download';
export { formatFileSize } from '../file-download';

export type DriveScope = string;

export interface DriveFolder {
  id: string;
  scope: DriveScope;
  parent_id: string | null;
  name: string;
  visibility: 'team' | 'private' | null;
  owner_user_id: string | null;
  base_id: string | null;
  /** Manual order among siblings; 0 = never dragged (falls back to name order). */
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DriveFile {
  id: string;
  scope: DriveScope;
  folder_id: string | null;
  name: string;
  cos_key: string;
  content_type: string | null;
  size: number;
  status: 'pending' | 'active' | 'deleted';
  visibility: 'team' | 'private' | null;
  owner_user_id: string | null;
  base_id: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Owner keys identifying which scope/container a node belongs to.
 *
 * The third member is how an extension addresses its own cabinet: any scope it
 * registered on the API, plus the `owner_key` whose meaning only it knows.
 */
export type DriveOwner =
  | { scope: string; visibility: 'team' | 'private'; base_id?: never; owner_key?: never }
  | { scope: 'tables'; base_id: string; visibility?: never; owner_key?: never }
  | { scope: string; owner_key: string };

/** The extension member of the union — `scope` alone cannot discriminate it. */
export function isExtensionDriveOwner(owner: DriveOwner): owner is { scope: string; owner_key: string } {
  return typeof owner.owner_key === 'string';
}

async function jsonReq<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await authFetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

function ownerQuery(owner: DriveOwner): string {
  if (isExtensionDriveOwner(owner))
    return `scope=${encodeURIComponent(owner.scope)}&owner_key=${encodeURIComponent(owner.owner_key)}`;
  if (owner.scope === 'tables') return `scope=tables&base_id=${owner.base_id}`;
  return `scope=${encodeURIComponent(owner.scope)}&visibility=${owner.visibility}`;
}

/**
 * List folders. `parentId` = a folder id for its children, `null` for the root
 * level, or `'all'` for every folder in the scope (flat — build the tree client
 * side in one request instead of walking level by level).
 */
export async function listDriveFolders(owner: DriveOwner, parentId: string | null | 'all'): Promise<DriveFolder[]> {
  const q = `${ownerQuery(owner)}${parentId != null ? `&parent_id=${parentId}` : ''}`;
  const { folders } = await jsonReq<{ folders: DriveFolder[] }>(`/api/drive/folders?${q}`, 'GET');
  return folders;
}

export async function listDriveFiles(owner: DriveOwner, folderId: string | null): Promise<DriveFile[]> {
  const q = `${ownerQuery(owner)}${folderId != null ? `&folder_id=${folderId}` : ''}`;
  const { files } = await jsonReq<{ files: DriveFile[] }>(`/api/drive/files?${q}`, 'GET');
  return files;
}

export async function driveBreadcrumb(folderId: string): Promise<DriveFolder[]> {
  const { folders } = await jsonReq<{ folders: DriveFolder[] }>(`/api/drive/breadcrumb?folder_id=${folderId}`, 'GET');
  return folders;
}

export async function createDriveFolder(
  owner: DriveOwner,
  parentId: string | null,
  name: string,
): Promise<DriveFolder> {
  const { folder } = await jsonReq<{ folder: DriveFolder }>('/api/drive/folders', 'POST', {
    ...owner,
    parent_id: parentId ?? undefined,
    name,
  });
  return folder;
}

/** Rename and/or move a folder. `parent_id: null` moves it to the root. */
export async function updateDriveFolder(
  id: string,
  patch: { name?: string; parent_id?: string | null },
): Promise<DriveFolder> {
  const { folder } = await jsonReq<{ folder: DriveFolder }>(`/api/drive/folders/${id}`, 'PUT', patch);
  return folder;
}

export async function deleteDriveFolder(id: string): Promise<void> {
  await jsonReq(`/api/drive/folders/${id}`, 'DELETE');
}

/** Rename and/or move a file. `folder_id: null` moves it to the root of its cabinet. */
export async function updateDriveFile(
  id: string,
  patch: { name?: string; folder_id?: string | null },
): Promise<DriveFile> {
  const { file } = await jsonReq<{ file: DriveFile }>(`/api/drive/files/${id}`, 'PUT', patch);
  return file;
}

/** Name search over the knowledge cabinet: team files plus the caller's personal ones. */
/** What the search returns: cabinet views, with the shelf and the Files page address of each. */
export interface CabinetSearchResult {
  folders: CabinetFolderView[];
  files: CabinetFileView[];
}

export async function searchKnowledgeCabinet(query: string, limit = 30): Promise<CabinetSearchResult> {
  return jsonReq<CabinetSearchResult>(`/api/drive/search?q=${encodeURIComponent(query)}&limit=${limit}`, 'GET');
}

/** Authenticated content URL of a file (download, or preview as a blob). */
export function driveFileContentUrl(file: Pick<DriveFile, 'id'>): string {
  return `/api/drive/files/${file.id}/content`;
}

export async function deleteDriveFile(id: string): Promise<void> {
  await jsonReq(`/api/drive/files/${id}`, 'DELETE');
}

/**
 * Upload one file: init → upload bytes → (presigned: confirm). Works in both
 * backends — direct presigned PUT to COS, or proxy PUT through the API on local.
 */
export async function uploadDriveFile(owner: DriveOwner, folderId: string | null, file: File): Promise<void> {
  const init = await jsonReq<{ file_id: string; mode: 'cos' | 'proxy'; upload_url: string }>(
    '/api/drive/files/init',
    'POST',
    {
      ...owner,
      folder_id: folderId ?? undefined,
      name: file.name,
      size: file.size,
      content_type: file.type || undefined,
    },
  );

  if (init.mode === 'cos') {
    const put = await fetch(init.upload_url, { method: 'PUT', body: file });
    if (!put.ok) throw new Error('上传到对象存储失败');
    await jsonReq(`/api/drive/files/${init.file_id}/complete`, 'POST', {});
  } else {
    const put = await authFetch(init.upload_url, {
      method: 'PUT',
      headers: file.type ? { 'content-type': file.type } : undefined,
      body: file,
    });
    if (!put.ok) throw new Error('上传失败');
  }
}

/**
 * Download a file. Hits the authed content endpoint and saves the blob — this
 * works for both backends (the endpoint either streams locally or 302s to a
 * short-lived presigned COS URL, which fetch follows).
 */
export async function downloadDriveFile(file: DriveFile): Promise<void> {
  return downloadAuthenticatedFile(driveFileContentUrl(file), file.name).catch(() => {
    throw new Error('下载失败');
  });
}

export async function fetchDriveCabinetScope(): Promise<string> {
  const response = await authFetch('/api/drive/cabinet');
  if (!response.ok) throw new Error('Could not load the file cabinet');
  return ((await response.json()) as { scope: string }).scope;
}
