/**
 * Files (云盘) page addresses — built by the Files tools for the model to cite,
 * parsed by the web page. One module so the two directions cannot drift.
 *
 * The page browses the knowledge cabinet (drive scope `kb`): the team's files
 * and the viewer's own. `team` / `personal` are the user-facing names of the
 * stored `visibility` values `team` / `private`.
 */

export type FilesShelf = 'team' | 'personal';

export interface FilesLocation {
  shelf: FilesShelf;
  folderId?: string | null;
  /** Open this file's preview once the folder has loaded. */
  fileId?: string | null;
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

/** A row id from the query string (opaque text; carried 1.x ids are digits), or null. */
function rowId(raw: string | null): string | null {
  return raw && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(raw) ? raw : null;
}

export function parseFilesLocation(params: URLSearchParams): FilesLocation {
  return {
    shelf: params.get('shelf') === 'personal' ? 'personal' : 'team',
    folderId: rowId(params.get('folder')),
    fileId: rowId(params.get('file')),
  };
}

/**
 * A folder / file as the knowledge cabinet hands it out — to the files_* tools
 * and from `GET /api/drive/search`. `url` is this page's address for it.
 */
export interface CabinetFolderView {
  id: string;
  name: string;
  shelf: FilesShelf;
  parent_id: string | null;
  url: string;
}

export interface CabinetFileView {
  id: string;
  name: string;
  shelf: FilesShelf;
  folder_id: string | null;
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
