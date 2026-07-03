/**
 * In-memory handoff for the fullscreen table viewer. The inline table's “全屏”
 * button stashes its parsed grid here and navigates to /table with just a key —
 * this avoids serialising a potentially large grid through navigation params
 * (which would bloat the router URL and choke on big tables).
 *
 * The map is bounded (oldest entries evicted) since each opened table leaks one
 * entry; 40 is far more than a user can have open at once.
 */

export type Align = 'left' | 'center' | 'right';

export interface TableData {
  head: string[];
  rows: string[][];
  align?: Align[];
}

let counter = 0;
const store = new Map<string, TableData>();
const MAX = 40;

export function putTable(t: TableData): string {
  const key = `tbl_${++counter}`;
  store.set(key, t);
  while (store.size > MAX) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return key;
}

export function getTable(key?: string | string[]): TableData | undefined {
  const k = Array.isArray(key) ? key[0] : key;
  return k ? store.get(k) : undefined;
}
