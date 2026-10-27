/**
 * A knowledge shelf as the phone keeps it offline: every folder and document of the shelf (the
 * tree is built from these flat lists, ./kb-tree.ts). React-free (./kb-shelf.test.ts).
 */

import { objectId } from '../lib/object-id';
import type { DriveFolder, KbDoc } from '../shared/greenhouse-types';

export interface Shelf {
  folders: DriveFolder[];
  docs: KbDoc[];
}

type Saved = Record<string, unknown>;

/** A saved folder with its ids as text (shelves saved before 3.0 hold numbers), or none. */
function folderOf(value: unknown): DriveFolder[] {
  const v = value as Saved | null;
  const id = objectId(v?.id);
  if (!v || !id || typeof v.name !== 'string') return [];
  return [{ ...(v as unknown as DriveFolder), id, parent_id: objectId(v.parent_id) }];
}

/** A saved document with its ids as text (shelves saved before 3.0 hold numbers), or none. */
function docOf(value: unknown): KbDoc[] {
  const v = value as Saved | null;
  const id = objectId(v?.id);
  if (!v || !id || typeof v.title !== 'string') return [];
  return [{ ...(v as unknown as KbDoc), id, folder_id: objectId(v.folder_id) }];
}

/** A saved shelf, or null when what was saved is not one. Document bodies are not kept. */
export function parseShelf(saved: unknown): Shelf | null {
  const value = saved as Partial<Shelf> | null;
  if (!value || !Array.isArray(value.folders) || !Array.isArray(value.docs)) return null;
  return { folders: value.folders.flatMap(folderOf), docs: value.docs.flatMap(docOf) };
}
