/**
 * A knowledge shelf as the phone keeps it offline: every folder and document of the shelf (the
 * tree is built from these flat lists, ./kb-tree.ts). React-free (./kb-shelf.test.ts).
 */

import type { DriveFolder, KbDoc } from '../shared/greenhouse-types';

export interface Shelf {
  folders: DriveFolder[];
  docs: KbDoc[];
}

const isFolder = (value: unknown): value is DriveFolder =>
  !!value && typeof (value as DriveFolder).id === 'number' && typeof (value as DriveFolder).name === 'string';

const isDoc = (value: unknown): value is KbDoc =>
  !!value && typeof (value as KbDoc).id === 'number' && typeof (value as KbDoc).title === 'string';

/** A saved shelf, or null when what was saved is not one. Document bodies are not kept. */
export function parseShelf(saved: unknown): Shelf | null {
  const value = saved as Partial<Shelf> | null;
  if (!value || !Array.isArray(value.folders) || !Array.isArray(value.docs)) return null;
  return { folders: value.folders.filter(isFolder), docs: value.docs.filter(isDoc) };
}
