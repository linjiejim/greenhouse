/**
 * The knowledge cabinet — what Files (档案库) shows: drive scope `kb`, the team's
 * nodes plus the caller's own personal ones.
 *
 * This is the agent-facing half of /api/drive for that one scope, used by the
 * `files_query` / `files_mutation` tools. Every operation authorizes every node
 * it touches with resolveDriveAccess (the single drive rule) and keeps moves
 * inside one cabinet, exactly as the HTTP routes do; nothing here widens what a
 * member can already do in the browser.
 *
 * Results are plain objects, and refusals are `{ error }` values phrased for a
 * model: what went wrong and what to do instead.
 */

import type { DatabaseProvider, DriveFileRow, DriveFolderRow } from '@greenhouse/db';
import type { ActorContext } from '@greenhouse/platform-kernel';
import {
  filesPageHref,
  shelfOfVisibility,
  visibilityOfShelf,
  type CabinetFileView,
  type CabinetFolderView,
  type FilesShelf,
} from '@greenhouse/types/files';

export type { CabinetFileView, CabinetFolderView };
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { canReadDrive, canWriteDrive, resolveDriveAccess, sameDriveCabinet, type DriveAccessNode } from './access.js';
import { recordDriveChange } from './audit.js';
import { DOWNLOAD_URL_TTL_SECONDS, MAX_AGENT_UPLOAD_BYTES } from './cabinet-limits.js';
import { safeDriveContentType, validateDriveUpload } from './upload-policy.js';
import { DEFAULT_MAX_CHARS, HARD_MAX_CHARS, MAX_READABLE_BYTES, extractText } from '../files/extract-text.js';
import { deleteObjectAtKey, driveKeyFor, getObjectAtKey, presignGetUrl, putObjectAtKey } from '../storage/uploads.js';

export { MAX_AGENT_UPLOAD_BYTES, DOWNLOAD_URL_TTL_SECONDS };

export interface CabinetCaller {
  db: DatabaseProvider;
  userId: string;
  /** Who the audit row names: the member, or the agent acting for them. */
  actor: ActorContext;
}

export type CabinetResult<T> = T | { error: string };

function folderView(row: DriveFolderRow): CabinetFolderView {
  const shelf = shelfOfVisibility(row.visibility);
  return {
    id: row.id,
    name: row.name,
    shelf,
    parent_id: row.parent_id,
    url: filesPageHref({ shelf, folderId: row.id }),
  };
}

function fileView(row: DriveFileRow): CabinetFileView {
  const shelf = shelfOfVisibility(row.visibility);
  return {
    id: row.id,
    name: row.name,
    shelf,
    folder_id: row.folder_id,
    size: row.size,
    content_type: row.content_type,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    url: filesPageHref({ shelf, folderId: row.folder_id, fileId: row.id }),
  };
}

/** The root of one shelf as an access node (who may list or create at its top level). */
function shelfRoot(userId: string, shelf: FilesShelf): DriveAccessNode {
  const visibility = visibilityOfShelf(shelf);
  return { scope: 'kb', visibility, owner_user_id: visibility === 'private' ? userId : null };
}

const access = (caller: CabinetCaller, node: DriveAccessNode) => resolveDriveAccess(node, caller.userId, {});

const notFound = (what: 'folder' | 'file', id: number) =>
  ({ error: `No ${what} with id "${id}" that you can see. Use search or list to find the right id.` }) as const;

async function readableFolder(caller: CabinetCaller, id: number): Promise<CabinetResult<DriveFolderRow>> {
  const folder = await caller.db.drive.getFolder(id);
  if (!folder || folder.scope !== 'kb' || !canReadDrive(access(caller, folder))) return notFound('folder', id);
  return folder;
}

async function writableFolder(caller: CabinetCaller, id: number): Promise<CabinetResult<DriveFolderRow>> {
  const folder = await readableFolder(caller, id);
  if ('error' in folder) return folder;
  if (!canWriteDrive(access(caller, folder))) return { error: `You cannot change folder "${folder.name}".` };
  return folder;
}

async function readableFile(caller: CabinetCaller, id: number): Promise<CabinetResult<DriveFileRow>> {
  const file = await caller.db.drive.getFile(id);
  if (!file || file.scope !== 'kb' || file.status !== 'active' || !canReadDrive(access(caller, file))) {
    return notFound('file', id);
  }
  return file;
}

async function writableFile(caller: CabinetCaller, id: number): Promise<CabinetResult<DriveFileRow>> {
  const file = await readableFile(caller, id);
  if ('error' in file) return file;
  if (!canWriteDrive(access(caller, file))) return { error: `You cannot change file "${file.name}".` };
  return file;
}

// ─── Reads ───────────────────────────────────────────────

export async function listCabinetFolder(
  caller: CabinetCaller,
  input: { shelf: FilesShelf; folderId?: number | null },
): Promise<
  CabinetResult<{ folder: CabinetFolderView | null; folders: CabinetFolderView[]; files: CabinetFileView[] }>
> {
  const root = shelfRoot(caller.userId, input.shelf);
  let parent: DriveFolderRow | null = null;
  if (input.folderId) {
    const found = await readableFolder(caller, input.folderId);
    if ('error' in found) return found;
    if (!sameDriveCabinet(found, root)) {
      return { error: `Folder "${input.folderId}" is not on the ${input.shelf} shelf.` };
    }
    parent = found;
  } else if (!canReadDrive(access(caller, root))) {
    return { error: 'You cannot read this shelf.' };
  }
  const owner = { visibility: root.visibility ?? undefined, owner_user_id: root.owner_user_id ?? undefined };
  const [folders, files] = await Promise.all([
    caller.db.drive.listFolders({ scope: 'kb', ...owner, parent_id: parent?.id ?? null }),
    caller.db.drive.listFiles({ scope: 'kb', ...owner, folder_id: parent?.id ?? null }),
  ]);
  return {
    folder: parent ? folderView(parent) : null,
    folders: folders.map(folderView),
    files: files.map(fileView),
  };
}

export async function searchCabinet(
  caller: CabinetCaller,
  input: { query: string; limit?: number },
): Promise<CabinetResult<{ folders: CabinetFolderView[]; files: CabinetFileView[] }>> {
  const query = input.query.trim();
  if (!query) return { error: 'query is required.' };
  const found = await caller.db.drive.searchKb({ userId: caller.userId, query, limit: input.limit });
  return {
    folders: found.folders.filter((row) => canReadDrive(access(caller, row))).map(folderView),
    files: found.files.filter((row) => canReadDrive(access(caller, row))).map(fileView),
  };
}

export async function getCabinetFile(
  caller: CabinetCaller,
  fileId: number,
): Promise<CabinetResult<CabinetFileView & { path: string[] }>> {
  const file = await readableFile(caller, fileId);
  if ('error' in file) return file;
  const chain = file.folder_id ? await caller.db.drive.breadcrumb(file.folder_id) : [];
  return { ...fileView(file), path: chain.map((folder) => folder.name) };
}

export async function cabinetDownloadUrl(
  caller: CabinetCaller,
  fileId: number,
): Promise<CabinetResult<{ file: CabinetFileView; download_url: string; expires_in_seconds: number }>> {
  const file = await readableFile(caller, fileId);
  if ('error' in file) return file;
  const url = await presignGetUrl(file.cos_key, DOWNLOAD_URL_TTL_SECONDS, {
    filename: file.name,
    contentType: safeDriveContentType(file.name),
  });
  if (!url) {
    return {
      error:
        'This deployment keeps files on the server itself, so there are no direct download links. ' +
        'Use files.read for documents, or ask your user to download it from the Files page.',
    };
  }
  return { file: fileView(file), download_url: url, expires_in_seconds: DOWNLOAD_URL_TTL_SECONDS };
}

export async function readCabinetFile(
  caller: CabinetCaller,
  input: { fileId: number; maxChars?: number },
): Promise<CabinetResult<{ file: CabinetFileView; text: string; total_chars: number; truncated: boolean }>> {
  const file = await readableFile(caller, input.fileId);
  if ('error' in file) return file;
  if (file.size > MAX_READABLE_BYTES) {
    return {
      error: `"${file.name}" is ${Math.round(file.size / 1024 / 1024)} MB; files over ${MAX_READABLE_BYTES / 1024 / 1024} MB cannot be read as text. Use files.download_url instead.`,
    };
  }
  const object = await getObjectAtKey(file.cos_key);
  if (!object) return { error: `The bytes of "${file.name}" are missing from storage.` };
  const extracted = await extractText(object.buffer, file.name, file.content_type ?? '');
  if (!extracted.ok) {
    return { error: `${extracted.message} Use files.download_url to fetch the original instead.` };
  }
  const limit = Math.min(Math.max(input.maxChars ?? DEFAULT_MAX_CHARS, 1), HARD_MAX_CHARS);
  return {
    file: fileView(file),
    text: extracted.text.slice(0, limit),
    total_chars: extracted.text.length,
    truncated: extracted.text.length > limit,
  };
}

// ─── Writes ──────────────────────────────────────────────

function cleanName(name: string): CabinetResult<string> {
  const trimmed = name.trim();
  if (!trimmed) return { error: 'name is required.' };
  if (trimmed.length > 255) return { error: 'name is longer than 255 characters.' };
  if (trimmed.includes('/') || trimmed.includes('\\')) return { error: 'name cannot contain "/" or "\\".' };
  return trimmed;
}

/** The folder a new node goes into, checked against the shelf it is created on. */
async function targetFolder(
  caller: CabinetCaller,
  shelf: FilesShelf,
  folderId: number | null | undefined,
): Promise<CabinetResult<DriveFolderRow | null>> {
  const root = shelfRoot(caller.userId, shelf);
  if (!folderId) return canWriteDrive(access(caller, root)) ? null : { error: 'You cannot write to this shelf.' };
  const folder = await writableFolder(caller, folderId);
  if ('error' in folder) return folder;
  if (!sameDriveCabinet(folder, root)) return { error: `Folder "${folderId}" is not on the ${shelf} shelf.` };
  return folder;
}

export async function createCabinetFolder(
  caller: CabinetCaller,
  input: { shelf: FilesShelf; parentId?: number | null; name: string },
): Promise<CabinetResult<{ folder: CabinetFolderView }>> {
  const name = cleanName(input.name);
  if (typeof name !== 'string') return name;
  const parent = await targetFolder(caller, input.shelf, input.parentId);
  if (parent && 'error' in parent) return parent;
  const root = shelfRoot(caller.userId, input.shelf);
  const folder = await caller.db.drive.createFolder({
    scope: 'kb',
    parent_id: parent?.id ?? null,
    name,
    visibility: root.visibility,
    owner_user_id: root.owner_user_id,
    created_by: caller.userId,
  });
  await recordDriveChange(caller.db, caller.actor, 'createFolder', { kind: 'folder', ...folder });
  return { folder: folderView(folder) };
}

export async function updateCabinetFolder(
  caller: CabinetCaller,
  input: { folderId: number; name?: string; parentId?: number | null },
): Promise<CabinetResult<{ folder: CabinetFolderView }>> {
  if (input.name === undefined && input.parentId === undefined) return { error: 'Pass name and/or parent_id.' };
  const folder = await writableFolder(caller, input.folderId);
  if ('error' in folder) return folder;
  let name: string | undefined;
  if (input.name !== undefined) {
    const cleaned = cleanName(input.name);
    if (typeof cleaned !== 'string') return cleaned;
    name = cleaned;
  }
  if (input.parentId != null) {
    const parent = await writableFolder(caller, input.parentId);
    if ('error' in parent) return parent;
    if (!sameDriveCabinet(parent, folder)) return { error: 'A folder can only move within its own shelf.' };
  }
  const result = await caller.db.drive.updateFolder(folder.id, { name, parent_id: input.parentId });
  if (!result.ok) {
    return result.reason === 'cycle'
      ? { error: 'A folder cannot move into itself or one of its own subfolders.' }
      : notFound('folder', input.folderId);
  }
  await recordDriveChange(caller.db, caller.actor, 'updateFolder', { kind: 'folder', ...result.folder });
  return { folder: folderView(result.folder) };
}

export async function deleteCabinetFolder(
  caller: CabinetCaller,
  folderId: number,
): Promise<CabinetResult<{ deleted: true; folder_id: number }>> {
  const folder = await writableFolder(caller, folderId);
  if ('error' in folder) return folder;
  const result = await caller.db.drive.deleteFolder(folder.id);
  if (!result.ok) {
    return result.reason === 'not_empty'
      ? { error: `Folder "${folder.name}" is not empty. Move or delete what is inside it first.` }
      : notFound('folder', folderId);
  }
  await recordDriveChange(caller.db, caller.actor, 'deleteFolder', { kind: 'folder', ...folder });
  return { deleted: true, folder_id: folder.id };
}

export async function uploadCabinetFile(
  caller: CabinetCaller,
  input: { shelf: FilesShelf; folderId?: number | null; name: string; bytes: Buffer },
): Promise<CabinetResult<{ file: CabinetFileView }>> {
  const name = cleanName(input.name);
  if (typeof name !== 'string') return name;
  if (input.bytes.length > MAX_AGENT_UPLOAD_BYTES) {
    return {
      error: `Agents can upload up to ${MAX_AGENT_UPLOAD_BYTES / 1024 / 1024} MB per file; ask your user to upload larger files on the Files page.`,
    };
  }
  const allowed = validateDriveUpload({ name, size: input.bytes.length });
  if (!allowed.ok) return { error: allowed.error };
  const folder = await targetFolder(caller, input.shelf, input.folderId);
  if (folder && 'error' in folder) return folder;

  const root = shelfRoot(caller.userId, input.shelf);
  const cosKey = driveKeyFor({ scope: 'kb', visibility: root.visibility, filename: name });
  const contentType = safeDriveContentType(name);
  const pending = await caller.db.drive.initFile({
    scope: 'kb',
    folder_id: folder?.id ?? null,
    name,
    cos_key: cosKey,
    content_type: contentType,
    size: input.bytes.length,
    visibility: root.visibility,
    owner_user_id: root.owner_user_id,
    uploaded_by: caller.userId,
  });
  try {
    await putObjectAtKey(cosKey, input.bytes, contentType);
  } catch (error) {
    await caller.db.drive.softDeleteFile(pending.id);
    logger.warn('[files] agent upload failed to store', { file: pending.id, error: toErrorMessage(error) });
    return { error: 'Storing the file failed; nothing was saved. Try again later.' };
  }
  const file = (await caller.db.drive.completeFile(pending.id, { size: input.bytes.length })) ?? pending;
  await recordDriveChange(caller.db, caller.actor, 'uploadFile', { kind: 'file', ...file }, { size: file.size });
  return { file: fileView(file) };
}

export async function updateCabinetFile(
  caller: CabinetCaller,
  input: { fileId: number; name?: string; folderId?: number | null },
): Promise<CabinetResult<{ file: CabinetFileView }>> {
  if (input.name === undefined && input.folderId === undefined) return { error: 'Pass name and/or folder_id.' };
  const file = await writableFile(caller, input.fileId);
  if ('error' in file) return file;
  let name: string | undefined;
  if (input.name !== undefined) {
    const cleaned = cleanName(input.name);
    if (typeof cleaned !== 'string') return cleaned;
    // A rename may not turn a document into something the upload policy refuses.
    const allowed = validateDriveUpload({ name: cleaned, size: file.size });
    if (!allowed.ok) return { error: allowed.error };
    name = cleaned;
  }
  if (input.folderId != null) {
    const folder = await writableFolder(caller, input.folderId);
    if ('error' in folder) return folder;
    if (!sameDriveCabinet(folder, file)) return { error: 'A file can only move within its own shelf.' };
  }
  const updated = await caller.db.drive.updateFile(file.id, { name, folder_id: input.folderId });
  if (!updated) return notFound('file', input.fileId);
  await recordDriveChange(caller.db, caller.actor, 'updateFile', { kind: 'file', ...updated });
  return { file: fileView(updated) };
}

export async function deleteCabinetFile(
  caller: CabinetCaller,
  fileId: number,
): Promise<CabinetResult<{ deleted: true; file_id: number }>> {
  const file = await writableFile(caller, fileId);
  if ('error' in file) return file;
  await caller.db.drive.softDeleteFile(file.id);
  deleteObjectAtKey(file.cos_key).catch((error) =>
    logger.warn(`[files] object GC failed for ${file.cos_key}: ${toErrorMessage(error)}`),
  );
  await recordDriveChange(caller.db, caller.actor, 'deleteFile', { kind: 'file', ...file });
  return { deleted: true, file_id: file.id };
}
