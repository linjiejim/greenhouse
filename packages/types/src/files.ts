/**
 * Files (档案库) page addresses — built by the Files tools for the model to cite,
 * parsed by the web page. One module so the two directions cannot drift.
 *
 * The page browses the knowledge cabinet (drive scope `kb`): the team's files
 * and the viewer's own. `team` / `personal` are the user-facing names of the
 * stored `visibility` values `team` / `private`.
 */

export type FilesShelf = 'team' | 'personal';

export interface FilesLocation {
  shelf: FilesShelf;
  folderId?: number | null;
  /** Open this file's preview once the folder has loaded. */
  fileId?: number | null;
}

export const FILES_ROOT_HASH = '#/files';

export function filesPageHref(location: FilesLocation): string {
  const params = new URLSearchParams();
  if (location.shelf === 'personal') params.set('shelf', 'personal');
  if (location.folderId) params.set('folder', String(location.folderId));
  if (location.fileId) params.set('file', String(location.fileId));
  const query = params.toString();
  return query ? `${FILES_ROOT_HASH}?${query}` : FILES_ROOT_HASH;
}

function positiveInt(raw: string | null): number | null {
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseFilesLocation(params: URLSearchParams): FilesLocation {
  return {
    shelf: params.get('shelf') === 'personal' ? 'personal' : 'team',
    folderId: positiveInt(params.get('folder')),
    fileId: positiveInt(params.get('file')),
  };
}

/**
 * A folder / file as the knowledge cabinet hands it out — to the files_* tools
 * and from `GET /api/drive/search`. `url` is this page's address for it.
 */
export interface CabinetFolderView {
  id: number;
  name: string;
  shelf: FilesShelf;
  parent_id: number | null;
  url: string;
}

export interface CabinetFileView {
  id: number;
  name: string;
  shelf: FilesShelf;
  folder_id: number | null;
  size: number;
  content_type: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  url: string;
}

/** Stored drive visibility ↔ shelf name. */
export function shelfOfVisibility(visibility: 'team' | 'private' | null | undefined): FilesShelf {
  return visibility === 'private' ? 'personal' : 'team';
}

export function visibilityOfShelf(shelf: FilesShelf): 'team' | 'private' {
  return shelf === 'personal' ? 'private' : 'team';
}
