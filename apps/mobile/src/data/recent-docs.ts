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

/**
 * What a failed read of a document means for the copy saved on this phone:
 * - `gone`: the server says it is not there or no longer mine to read (403 / 404 / 410) — the
 *   copy is deleted and stops showing, so revoked access never lingers offline;
 * - `unreachable`: no answer from the station (no network, or a gateway that cannot reach it) —
 *   the saved copy, if any, is shown and marked as such;
 * - `failed`: the station answered with another error — no copy, an error with a retry.
 */
export type DocMiss = 'gone' | 'unreachable' | 'failed';

export function docMiss(status: number): DocMiss {
  if (status === 403 || status === 404 || status === 410) return 'gone';
  if (status === 0 || status === 502 || status === 503 || status === 504) return 'unreachable';
  return 'failed';
}
