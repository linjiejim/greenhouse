import { DEFAULT_API_BASE } from '../config.web';
import { browserStorageKey } from '../stations/browser-origin';
const storageKey = (key: string) =>
  browserStorageKey(key, DEFAULT_API_BASE, typeof location === 'undefined' ? DEFAULT_API_BASE : location.origin);
/** Same localStorage policy as classic web; failures leave the in-memory session usable. */
export async function persistGet(key: string): Promise<string | null> {
  try {
    return globalThis.localStorage?.getItem(storageKey(key)) ?? null;
  } catch {
    return null;
  }
}
export function persistSet(key: string, value: string | null): void {
  try {
    if (value == null) globalThis.localStorage?.removeItem(storageKey(key));
    else globalThis.localStorage?.setItem(storageKey(key), value);
  } catch {
    /* private browsing / quota */
  }
}
