/**
 * In-memory handoff for data that has to travel to another route but has no
 * URL of its own (a tool-call trace, a parsed table, a reference list).
 *
 * The sender stashes the payload and navigates with just the returned key
 * (`/peek/tools?k=…`); the receiving screen reads it back. This keeps large or
 * structured payloads out of navigation params (which bloat the router URL and
 * must be strings). The map is bounded — oldest entries are evicted — since
 * each opened peek leaks one entry; a missing key means "gone", and receivers
 * must render an empty state rather than crash.
 */

let counter = 0;
const store = new Map<string, unknown>();
const MAX = 60;

export function putHandoff<T>(kind: string, value: T): string {
  const key = `${kind}_${++counter}`;
  store.set(key, value);
  while (store.size > MAX) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return key;
}

export function getHandoff<T>(key?: string | string[]): T | undefined {
  const k = Array.isArray(key) ? key[0] : key;
  return k ? (store.get(k) as T | undefined) : undefined;
}
