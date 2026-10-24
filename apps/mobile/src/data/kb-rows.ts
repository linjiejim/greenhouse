/**
 * The rows of a knowledge shelf's top or folder level. React-free (./kb-rows.test.ts). At a
 * shelf's top the recently opened documents come first — whether or not the shelf itself loaded,
 * so on a cold launch without the station they still open from their saved copies; below them
 * the shelf's folders and documents, or, while it loads or when it failed, a row saying so.
 */

import type { DriveFolder, KbDoc } from '../shared/greenhouse-types';
import type { RecentDoc } from './recent-docs';

import { rowPosition, type RowPosition } from './row-position';

export type Position = RowPosition;

export type KbRow =
  | { key: string; type: 'header'; title: string }
  | { key: string; type: 'folder'; folder: DriveFolder; position: Position }
  | { key: string; type: 'doc'; id: string; title: string; subtitle?: string; position: Position }
  | { key: string; type: 'loading' }
  | { key: string; type: 'failed' };

/** How many recently opened documents the top of a shelf lists. */
export const RECENT_ON_SHELF = 5;

export function positioned<T>(items: readonly T[], make: (item: T, position: Position) => KbRow): KbRow[] {
  return items.map((item, index) =>
    make(item, rowPosition(index, items.length)),
  );
}

export function shelfRows(input: {
  /** At the shelf's top (not inside a folder). */
  atTop: boolean;
  recent: readonly RecentDoc[];
  /** The level's folders and documents, or null while it has not loaded. */
  level: { folders: DriveFolder[]; docs: KbDoc[] } | null;
  loading: boolean;
  titles: { recent: string; shelf: string };
  docSubtitle: (doc: KbDoc) => string | undefined;
}): KbRow[] {
  const recent = input.atTop ? input.recent.slice(0, RECENT_ON_SHELF) : [];
  const out: KbRow[] = [];
  if (recent.length) {
    out.push({ key: 'h-recent', type: 'header', title: input.titles.recent });
    out.push(
      ...positioned(recent, (entry, position) => ({ key: `recent-${entry.id}`, type: 'doc', id: entry.id, title: entry.title, position })),
    );
  }
  if (!input.level) {
    // with nothing above, the screen's own empty state says loading / failed
    if (out.length) out.push(input.loading ? { key: 'loading', type: 'loading' } : { key: 'failed', type: 'failed' });
    return out;
  }
  if (recent.length) out.push({ key: 'h-shelf', type: 'header', title: input.titles.shelf });
  // folders and documents share one card
  const level = input.level;
  const count = level.folders.length + level.docs.length;
  level.folders.forEach((folder, index) => out.push({ key: `f-${folder.id}`, type: 'folder', folder, position: rowPosition(index, count) }));
  level.docs.forEach((doc, index) =>
    out.push({
      key: `d-${doc.id}`,
      type: 'doc',
      id: doc.id,
      title: doc.title,
      subtitle: input.docSubtitle(doc),
      position: rowPosition(level.folders.length + index, count),
    }),
  );
  return out;
}
