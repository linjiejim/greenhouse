/**
 * One level of a knowledge or files shelf from flat lists. React-free (./kb-tree.test.ts): the
 * folders a level shows (manual order first, then by name), the documents filed in it, and the
 * path from the shelf's top to a folder.
 */

import type { DriveFolder, KbDoc } from '../shared/greenhouse-types';

const byOrderThenName = (a: DriveFolder, b: DriveFolder) =>
  (a.sort_order || Number.MAX_SAFE_INTEGER) - (b.sort_order || Number.MAX_SAFE_INTEGER) ||
  a.name.localeCompare(b.name);

export function levelOf(
  folders: readonly DriveFolder[],
  docs: readonly KbDoc[],
  folderId: string | null,
): { folders: DriveFolder[]; docs: KbDoc[] } {
  const known = new Set(folders.map((f) => f.id));
  // a document filed in a folder this shelf does not show (another shelf's, deleted) sits at the top
  const home = (doc: KbDoc) => (doc.folder_id != null && known.has(doc.folder_id) ? doc.folder_id : null);
  return {
    folders: folders.filter((f) => (f.parent_id ?? null) === folderId).sort(byOrderThenName),
    docs: docs
      .filter((doc) => doc.status !== 'archived' && home(doc) === folderId)
      .sort((a, b) => a.title.localeCompare(b.title)),
  };
}

/** The folders from the shelf's top down to `folderId` (empty for the top, or an unknown id). */
export function pathTo(folders: readonly DriveFolder[], folderId: string | null): DriveFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: DriveFolder[] = [];
  let current = folderId != null ? byId.get(folderId) : undefined;
  while (current && path.length < 50) {
    path.unshift(current);
    current = current.parent_id != null ? byId.get(current.parent_id) : undefined;
  }
  return path;
}
