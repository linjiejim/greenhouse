/**
 * Drive (云盘) API client — folders + files for the CRM customer file cabinet
 * (and, later, the knowledge base).
 *
 * Stays on raw authFetch (not hc): uploads PUT raw bytes and downloads stream a
 * blob, which the hc JSON conventions don't cover. The JSON endpoints ride the
 * same authFetch for one cohesive module.
 */

import { authFetch } from '../auth';
import { downloadAuthenticatedFile } from '../file-download';
export { formatFileSize } from '../file-download';

export type DriveScope = 'kb' | 'tables';

export interface DriveFolder {
  id: number;
  scope: DriveScope;
  parent_id: number | null;
  name: string;
  visibility: 'team' | 'private' | null;
  owner_user_id: string | null;
  base_id: number | null;
  /** Manual order among siblings; 0 = never dragged (falls back to name order). */
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DriveFile {
  id: number;
  scope: DriveScope;
  folder_id: number | null;
  name: string;
  cos_key: string;
  content_type: string | null;
  size: number;
  status: 'pending' | 'active' | 'deleted';
  visibility: 'team' | 'private' | null;
  owner_user_id: string | null;
  base_id: number | null;
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
  | { scope: 'kb'; visibility: 'team' | 'private'; owner_key?: never }
  | { scope: 'tables'; base_id: number; owner_key?: never }
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
  return `scope=kb&visibility=${owner.visibility}`;
}

/**
 * List folders. `parentId` = a folder id for its children, `null` for the root
 * level, or `'all'` for every folder in the scope (flat — build the tree client
 * side in one request instead of walking level by level).
 */
export async function listDriveFolders(owner: DriveOwner, parentId: number | null | 'all'): Promise<DriveFolder[]> {
  const q = `${ownerQuery(owner)}${parentId != null ? `&parent_id=${parentId}` : ''}`;
  const { folders } = await jsonReq<{ folders: DriveFolder[] }>(`/api/drive/folders?${q}`, 'GET');
  return folders;
}

export async function listDriveFiles(owner: DriveOwner, folderId: number | null): Promise<DriveFile[]> {
  const q = `${ownerQuery(owner)}${folderId != null ? `&folder_id=${folderId}` : ''}`;
  const { files } = await jsonReq<{ files: DriveFile[] }>(`/api/drive/files?${q}`, 'GET');
  return files;
}

export async function driveBreadcrumb(folderId: number): Promise<DriveFolder[]> {
  const { folders } = await jsonReq<{ folders: DriveFolder[] }>(`/api/drive/breadcrumb?folder_id=${folderId}`, 'GET');
  return folders;
}

export async function createDriveFolder(
  owner: DriveOwner,
  parentId: number | null,
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
  id: number,
  patch: { name?: string; parent_id?: number | null },
): Promise<DriveFolder> {
  const { folder } = await jsonReq<{ folder: DriveFolder }>(`/api/drive/folders/${id}`, 'PUT', patch);
  return folder;
}

export async function deleteDriveFolder(id: number): Promise<void> {
  await jsonReq(`/api/drive/folders/${id}`, 'DELETE');
}

export async function deleteDriveFile(id: number): Promise<void> {
  await jsonReq(`/api/drive/files/${id}`, 'DELETE');
}

/**
 * Upload one file: init → upload bytes → (presigned: confirm). Works in both
 * backends — direct presigned PUT to COS, or proxy PUT through the API on local.
 */
export async function uploadDriveFile(owner: DriveOwner, folderId: number | null, file: File): Promise<void> {
  const init = await jsonReq<{ file_id: number; mode: 'cos' | 'proxy'; upload_url: string }>(
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
  return downloadAuthenticatedFile(`/api/drive/files/${file.id}/content`, file.name).catch(() => {
    throw new Error('下载失败');
  });
}
