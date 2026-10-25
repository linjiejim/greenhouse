/**
 * The rows of the knowledge page. React-free (./kb-rows.test.ts).
 *
 *  - 最近打开 (the first segment): the documents this member opened on this phone, newest first,
 *    from the per-station + member list src/store/knowledge.ts keeps (there is no recent-documents
 *    endpoint). It needs no station, so on a cold launch offline they still open from their saved copies.
 *  - A shelf's level (团队 / 我的 / 共享): its folders, then its documents, in one card.
 *
 * Every document row is one line: the title, and its date at the trailing edge.
 */

import type { DriveFolder, KbDoc } from '../shared/greenhouse-types';
import type { RecentDoc } from './recent-docs';

import { rowPosition, type RowPosition } from './row-position';

export type Position = RowPosition;

export type KbRow =
  | { key: string; type: 'folder'; folder: DriveFolder; position: Position }
  | { key: string; type: 'doc'; id: string; title: string; subtitle?: string; date?: string; position: Position };

export function positioned<T>(items: readonly T[], make: (item: T, position: Position) => KbRow): KbRow[] {
  return items.map((item, index) => make(item, rowPosition(index, items.length)));
}

/** The recently opened documents, with the time each was opened. */
export function recentRows(recent: readonly RecentDoc[], dateOf: (entry: RecentDoc) => string): KbRow[] {
  return positioned(recent, (entry, position) => ({
    key: `recent-${entry.id}`,
    type: 'doc',
    id: entry.id,
    title: entry.title,
    date: dateOf(entry) || undefined,
    position,
  }));
}

/** A shelf level's folders and documents (none until it has loaded). */
export function shelfRows(
  level: { folders: DriveFolder[]; docs: KbDoc[] } | null,
  dateOf: (doc: KbDoc) => string,
): KbRow[] {
  if (!level) return [];
  const count = level.folders.length + level.docs.length;
  return [
    ...level.folders.map(
      (folder, index): KbRow => ({
        key: `f-${folder.id}`,
        type: 'folder',
        folder,
        position: rowPosition(index, count),
      }),
    ),
    ...level.docs.map(
      (doc, index): KbRow => ({
        key: `d-${doc.id}`,
        type: 'doc',
        id: doc.id,
        title: doc.title,
        date: dateOf(doc) || undefined,
        position: rowPosition(level.folders.length + index, count),
      }),
    ),
  ];
}
