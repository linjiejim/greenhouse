import { useExtensionsStore } from '../stores/extensions-store';
export type ExtensionRedirects = Partial<Record<'settings' | 'administration', Record<string, string>>>;
const entries: Array<{ id: string; redirects: ExtensionRedirects }> = [];
export function registerExtensionRedirects(id: string, redirects: ExtensionRedirects) {
  entries.push({ id, redirects });
}
export function resolveExtensionRedirect(scope: 'settings' | 'administration', subPath: string): string | null {
  const active = new Set(useExtensionsStore.getState().extensions.map((ext) => ext.id));
  const [key, ...tail] = subPath.split('/').filter(Boolean);
  for (const entry of entries) {
    if (!active.has(entry.id)) continue;
    const target = entry.redirects[scope]?.[key];
    if (target) return target + (tail.length ? '/' + tail.join('/') : '');
  }
  return null;
}
