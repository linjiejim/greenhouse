/** Optional station manifest. A 3.x station has all built-in places and no plugin pages. */
import type { PluginManifestEntry, PluginNavItem, PluginPage, StationManifest } from '../shared/plugins';
export type ManifestState = { kind: 'legacy' } | { kind: 'v2'; manifest: StationManifest };
export const LEGACY_MANIFEST: ManifestState = { kind: 'legacy' };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function parseManifest(value: unknown): ManifestState {
  if (!record(value)) throw new Error('Invalid station manifest');
  if (value.manifest_version !== 2) {
    if (value.manifest_version === undefined && Array.isArray(value.extensions) && Array.isArray(value.entityKinds))
      return LEGACY_MANIFEST;
    throw new Error('Unsupported station manifest version');
  }
  if (!record(value.core) || !Array.isArray(value.plugins)) throw new Error('Invalid station manifest');
  for (const plugin of value.plugins) {
    if (!record(plugin) || typeof plugin.id !== 'string' || !Array.isArray(plugin.nav) || !Array.isArray(plugin.pages))
      throw new Error('Invalid plugin manifest');
    for (const item of plugin.nav)
      if (
        !record(item) ||
        typeof item.id !== 'string' ||
        typeof item.page !== 'string' ||
        !['primary', 'more'].includes(String(item.placement))
      )
        throw new Error('Invalid plugin navigation');
    // Preserve future kinds: they must reach the unsupported-page fallback.
    for (const page of plugin.pages)
      if (!record(page) || typeof page.id !== 'string' || typeof page.kind !== 'string')
        throw new Error('Invalid plugin page');
  }
  return { kind: 'v2', manifest: value as unknown as StationManifest };
}
export async function fetchManifest(
  fetcher: () => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>,
): Promise<ManifestState> {
  const response = await fetcher();
  if (response.status === 404) return LEGACY_MANIFEST;
  if (!response.ok) throw new Error(`Station manifest: ${response.status}`);
  return parseManifest(await response.json());
}
export function hasPlugin(state: ManifestState, id: string): boolean {
  return state.kind === 'legacy' || state.manifest.plugins.some((p) => p.id === id);
}
/** v2 is already permission-filtered by the station; only legacy stations use local feature flags. */
export function builtinVisible(state: ManifestState, id: string, legacyAllowed = true): boolean {
  if (state.kind === 'legacy') return legacyAllowed;
  return pluginNavigation(state, 'primary').some((item) => item.page.kind === 'native' && item.page.screen === id);
}
export type PluginNavigation = { plugin: PluginManifestEntry; nav: PluginNavItem; page: PluginPage };
export function pluginNavigation(state: ManifestState, placement: 'primary' | 'more'): PluginNavigation[] {
  if (state.kind === 'legacy') return [];
  return state.manifest.plugins
    .flatMap((plugin) =>
      plugin.nav
        .filter((nav) => nav.placement === placement)
        .flatMap((nav) => {
          const page = plugin.pages.find((p) => p.id === nav.page);
          return page ? [{ plugin, nav, page }] : [];
        }),
    )
    .sort((a, b) => (a.nav.order ?? 100) - (b.nav.order ?? 100));
}
/** Only http(s) station/browser destinations may leave the client. */
export function fallbackUrl(page: { fallback_url?: string }, base: string): string | null {
  if (!page.fallback_url) return null;
  try {
    const url = new URL(page.fallback_url, base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.hash.startsWith('#/') && url.origin === new URL(base).origin && !url.pathname.startsWith('/classic'))
      url.pathname = '/classic/';
    return url.href;
  } catch {
    return null;
  }
}
