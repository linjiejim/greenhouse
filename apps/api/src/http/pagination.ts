import { invalidInput } from './errors.js';

/**
 * Cursors are opaque to clients. Ids are time-sortable ULIDs, so the last id of a page is
 * enough to resume; it is wrapped so the format can change without breaking clients.
 */
export function encodeCursor(lastId: string): string {
  return Buffer.from(JSON.stringify({ id: lastId })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id?: unknown };
    if (typeof value.id === 'string' && value.id.length <= 64) return value.id;
  } catch {
    // fall through
  }
  throw invalidInput('The cursor is invalid.');
}

/** Fetch `limit + 1` rows, then call this to build the page. */
export function toPage<T extends { id: string }, V>(rows: T[], limit: number, view: (row: T) => V) {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return { items: items.map(view), next_cursor: more ? encodeCursor(items[items.length - 1]!.id) : null };
}
