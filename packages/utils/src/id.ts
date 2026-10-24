/**
 * Row ids at the edges (routes, tools, MCP).
 *
 * Every primary key is text: new rows get a prefixed ULID (`doc_01J…`), rows
 * carried from 1.x keep their old value as a string (`"42"`). Callers — and
 * external agents that remember an old numeric id — may still send a number,
 * so inputs accept both and normalize to the string the database stores.
 */

const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** True for a well-formed row id. Says nothing about whether the row exists. */
export function isRowId(value: unknown): value is string {
  return typeof value === 'string' && ROW_ID.test(value);
}

/** Normalize an id that may arrive as a number (legacy clients) to its string form; null if malformed. */
export function toRowId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isRowId(trimmed) ? trimmed : null;
}
