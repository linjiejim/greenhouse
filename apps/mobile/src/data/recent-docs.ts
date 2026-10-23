/**
 * Recently opened documents, kept for offline reading. React-free (./recent-docs.test.ts): the
 * index of what was opened (newest first, capped), and each document's saved copy (title and
 * Markdown, never more). Stored per station + member by ../store/knowledge.ts.
 */

import type { KbDoc } from '../shared/greenhouse-types';

export const RECENT_MAX = 20;

export interface RecentDoc {
  id: number;
  title: string;
  openedAt: number;
}

export interface SavedDoc {
  v: 1;
  doc: Pick<KbDoc, 'id' | 'slug' | 'title' | 'content_markdown' | 'visibility' | 'updated_at' | 'folder_id'>;
  savedAt: number;
}

export function withOpened(list: readonly RecentDoc[], doc: Pick<KbDoc, 'id' | 'title'>, now: number): RecentDoc[] {
  return [{ id: doc.id, title: doc.title, openedAt: now }, ...list.filter((entry) => entry.id !== doc.id)].slice(
    0,
    RECENT_MAX,
  );
}

/** The ids that fell off the list (their saved copies go). */
export function dropped(before: readonly RecentDoc[], after: readonly RecentDoc[]): number[] {
  const kept = new Set(after.map((entry) => entry.id));
  return before.filter((entry) => !kept.has(entry.id)).map((entry) => entry.id);
}

export function parseRecent(value: unknown): RecentDoc[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is RecentDoc =>
        !!entry &&
        typeof entry === 'object' &&
        Number.isSafeInteger((entry as RecentDoc).id) &&
        typeof (entry as RecentDoc).title === 'string' &&
        typeof (entry as RecentDoc).openedAt === 'number',
    )
    .slice(0, RECENT_MAX);
}

export function toSaved(doc: KbDoc, now: number): SavedDoc {
  const { id, slug, title, content_markdown, visibility, updated_at, folder_id } = doc;
  return { v: 1, doc: { id, slug, title, content_markdown, visibility, updated_at, folder_id }, savedAt: now };
}

export function parseSaved(value: unknown, id: number): SavedDoc | null {
  const saved = value as Partial<SavedDoc> | null;
  if (!saved || saved.v !== 1 || !saved.doc || saved.doc.id !== id) return null;
  if (typeof saved.doc.title !== 'string' || typeof saved.doc.content_markdown !== 'string') return null;
  return saved as SavedDoc;
}
