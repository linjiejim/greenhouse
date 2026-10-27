import { cacheFileName, cacheFilePrefix } from './cache-key';
const ROOT = 'greenhouse_offline_';
export async function readCache(station: string, member: string, kind: string): Promise<unknown> {
  try {
    return JSON.parse(localStorage.getItem(ROOT + cacheFileName(station, member, kind)) ?? 'null');
  } catch {
    return null;
  }
}
export function writeCache(station: string, member: string, kind: string, value: unknown): void {
  try {
    localStorage.setItem(ROOT + cacheFileName(station, member, kind), JSON.stringify(value));
  } catch {
    /* quota */
  }
}
export function removeCache(station: string, member: string, kind: string): void {
  try {
    localStorage.removeItem(ROOT + cacheFileName(station, member, kind));
  } catch {
    /* unavailable */
  }
}
export function forgetMember(station: string, member?: string): void {
  try {
    const prefix = ROOT + cacheFilePrefix(station, member);
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
  } catch {
    /* unavailable */
  }
}
