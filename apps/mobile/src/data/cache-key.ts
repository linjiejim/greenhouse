/** File names of the offline copies (./disk-cache.ts). React-free (./cache-key.test.ts). */

const SAFE = /[^A-Za-z0-9._-]/g;
const part = (value: string) => value.replace(SAFE, '_').slice(0, 80);

/** `<station>__<member>__<kind>.json`, every part reduced to file-name-safe characters. */
export function cacheFileName(stationId: string, memberId: string, kind: string): string {
  return `${part(stationId)}__${part(memberId)}__${part(kind)}.json`;
}

/** The common start of one member's files on a station, or of every file of the station. */
export function cacheFilePrefix(stationId: string, memberId?: string): string {
  return memberId ? `${part(stationId)}__${part(memberId)}__` : `${part(stationId)}__`;
}
