/** Stable browser station identity, including an explicit development API origin. */
export function browserStationId(base: string): string {
  return `browser-${encodeURIComponent(new URL(base).origin).replace(/%/g, '_')}`;
}
/** Hosted clients share the classic token pair; a dev override stays scoped to its API. */
export function browserStorageKey(key: string, apiOrigin: string, hostingOrigin: string): string {
  const suffix = `__${browserStationId(apiOrigin)}`;
  if (new URL(apiOrigin).origin === new URL(hostingOrigin).origin && key.endsWith(suffix)) {
    const base = key.slice(0, -suffix.length);
    if (base === 'greenhouse_access_token' || base === 'greenhouse_refresh_token') return base;
  }
  return key;
}
