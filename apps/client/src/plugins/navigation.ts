import { builtinVisible, type ManifestState } from './manifest';
import { nativeScreens } from './native-registry';
export function nativeRoute(screen: string): string | undefined {
  return nativeScreens[screen]?.route;
}
export function nativeVisible(state: ManifestState, screen: string, legacyAllowed = true): boolean {
  return builtinVisible(state, screen, legacyAllowed);
}
export function pluginHref(plugin: string, page: { id: string; kind: string; screen?: string }): string {
  return (
    (page.kind === 'native' && page.screen && nativeRoute(page.screen)) ||
    `/p/${encodeURIComponent(plugin)}/${encodeURIComponent(page.id)}`
  );
}
